import { defineStore } from 'pinia'
import type { OssClient } from '@/utils/oss'
import { useAuthStore } from './auth'
import { useProjectsStore } from './projects'
import { useUiStore } from './ui'
import { useStatsStore } from './stats'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { applyDeletedTombstones, compareAndSwapPut, dedupTasksById, filterTasksForProject, lastModifiedOf, lmKeyOf, mergeDeletedTombstones, mergeTasks, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbClearTrashUserCache, idbGet, idbListKeys, idbPut, idbDel } from '@/utils/idb'
import { debounce, type Debounced } from '@/utils/debounce'
import { queueSyncChange } from '@/utils/syncReport'
import { clearReminderSyncPending, hasReminderSyncPending, markReminderSyncPending } from '@/utils/reminderSyncReport'
import { addDays, addDaysKey, dateKeyOf, diffDaysKey, nowIso, todayKey } from '@/utils/time'
import { isProjectTaskActiveToday, isTaskVisibleToday } from '@/utils/todayFilter'
import { buildOccurrenceTemplate, buildReminderPayload, buildRepeatOccurrence, hasNextUnprocessedRepeatDay, nextRepeatDate, repeatRuleFingerprint, repeatShapeEquals, rootIdOf, shiftTaskTimes, skipProcessedRepeatDays } from '@/utils/repeat'
import { api } from '@/api/client'
import { logAudit, logAttachmentDeletion, safeDetail } from '@/utils/audit'
import { UNCATEGORIZED, type AttachmentMeta, type RepeatMaster, type Subtask, type Task, type TombstoneEntry } from '@/types'
import { canonicalJson, compareAutoTasks, mergeOrderIds, newSubtask, normalizeTask, normalizeTasks, pendingSubtaskReminders, repeatAwareInsertIndex, repeatAwareInsertIndexForIds, timeInsertIndex } from '@/utils/task'
import { deleteAttachments, ossFileName } from '@/utils/attachments'
const saveDebouncers = new Map<string, Debounced<[]>>()
const trashDebouncers = new Map<string, Debounced<[]>>()
const tombstoneDebouncers = new Map<string, Debounced<[]>>()
// 每项目在途保存 Promise：确认式保存/即时保存共用，串行化同一文件的写入，
// 避免同一文件并发 CAS 写互相覆盖或误报“冲突合并”提示
const tasksSaving = new Map<string, Promise<boolean>>()
const trashSaving = new Map<string, Promise<boolean>>()
const repeatsSaving = new Map<string, Promise<boolean>>()
const tombstonesSaving = new Map<string, Promise<boolean>>()
const toggleSaving = new Set<string>()
const occurrenceSaving = new Set<string>()
/** 正在进行中的保存（含防抖触发的保存执行中）：期间禁止逐出该项目，避免 OSS 写一半被清内存 */
const savingNow = new Set<string>()
/** 内存常驻项目上限：超过上限的“最近最少使用”非固定项目会被逐出（仅内存，IDB 缓存保留，下次访问按需重载） */
const MAX_RESIDENT_PROJECTS = 10
/** 回收站分片拉取并发上限：有界并发下载分片，避免一次性打满网络/连接池 */
const TRASH_FETCH_CONCURRENCY = 8
/** 固定保留项目（不参与逐出）：
 *  - viewPins：当前视图聚焦的项目（正在浏览的项目 / 回收站展开的项目），由视图挂载/卸载时增删；
 *  - 今日相关项目：逐出时实时计算「内存里存在今日可见任务的项目」，保证今日视图/侧栏角标依赖的
 *    项目常驻（不随 profile 全量固定，否则几百个项目会把所有访问过的项目都钉在内存里，LRU 失效）。 */
const viewPins = new Set<string>()
/** 时间胶囊页打开期间固定的项目：胶囊需要所有项目的「已完成活跃任务」常驻内存，
 *  否则 LRU 逐出后日历图/项目图会丢失当天完成、尚未归档的已完成记录（不随 trash 一起释放）。 */
const capsulePins = new Set<string>()
/** LRU 访问顺序：越靠前越最近使用（项目加载/访问/写入时置顶） */
const accessOrder: string[] = []
/** 逐出互斥：防止并发 touch 触发多次逐出循环 */
let evicting = false
let syncReminderTimer: number | undefined
/** 到期物化互斥队列：轮询同步、跨天定时器、打开项目等多个入口可能同时触发物化；
 *  若并发读取同一批到期模板，会把同一个重复任务重复生成两份。串行化后每个调用
 *  都基于上一轮完成后的最新状态执行（已到期的模板已被移除，自然不会重复生成）。 */
let materializeChain: Promise<unknown> = Promise.resolve()
/** 项目加载的 in-flight Promise：ProjectView 的 onMounted 与路由 watch 会同时调用
 *  loadProject，复用同一个请求避免打开项目时重复下载该项目的 tasks/repeats 数据包。 */
const loadingProjectPromises = new Map<string, Promise<void>>()
/* ---- 读路径回写熔断（防多端互写风暴）----
 * syncProject 在“合并结果与远端不一致”时会回写 OSS，回写成功又会广播变更事件唤醒对端，
 * 对端再回写……正常数据下最多一两轮即收敛；但病态数据（对端持续产生反向差异 / 未上云的
 * 幽灵副本）会让这个环每 2 秒轮询都触发一次 PUT。这里对同一项目的回写做窗口限流：
 * 超限即跳过本轮回写并告警，宁可短暂保留本地视图，也不无限刷 OSS。 */
const WRITEBACK_WINDOW_MS = 30_000
const WRITEBACK_MAX_PER_WINDOW = 5
const writeBackTimes = new Map<string, number[]>()
function allowWriteBack(projectId: string): boolean {
  const now = Date.now()
  const list = (writeBackTimes.get(projectId) ?? []).filter((t) => now - t < WRITEBACK_WINDOW_MS)
  if (list.length >= WRITEBACK_MAX_PER_WINDOW) {
    writeBackTimes.set(projectId, list)
    console.warn(
      `[同步] 项目 ${projectId} 读路径回写在 ${WRITEBACK_WINDOW_MS / 1000}s 内已达 ${list.length} 次，跳过本轮回写（防多端互写风暴）`,
    )
    return false
  }
  list.push(now)
  writeBackTimes.set(projectId, list)
  return true
}
/** 任务文件固定存 projects/{pid}/tasks.json（未分类活跃任务存储 today.json 已下线，所有任务强制归属真实项目） */
function tasksFilePath(username: string, projectId: string): string {
  return paths.tasks(username, projectId)
}
/** 未分类回收站存 today_trash.json（单文件不分片）；真实项目回收站按月分片存 trash/{YYYY-MM}.json */
function trashFilePath(username: string, projectId: string, month?: string): string {
  return projectId === UNCATEGORIZED
    ? paths.todayTrash(username)
    : month
      ? paths.trashShard(username, projectId, month)
      : paths.trash(username, projectId)
}
/* ---- 时间胶囊墓碑日志（tombstones 按月分片）----
 * 墓碑只存 {id, updatedAt}（任务离开活跃列表时的 updatedAt），
 * 用于多端同步「防复活」：active 合并时按此集合剔除已被他端完成/删除归档的任务，
 * 让日常同步不再为防复活而下载当月/上月回收站分片（时间胶囊数据回归懒加载）。
 *
 * 【分片布局】（B1 优化：单文件 570KB → 当月分片 ~95KB，治写放大）
 *  - tombstoneShards[pid][YYYY-MM]  → OSS tombstones/{YYYY-MM}.json，存「普通墓碑」
 *      + 当月的 purged:<id> 副本（让来不及读长库的端也能看到近期永久删除证据）；
 *  - tombstonePurged[pid]           → OSS tombstones.json（沿用旧路径），只存 purged:<id>，
 *      保留 180 天（唯一还做时间裁剪的桶，用 nowIso() 写入，见 permanentDelete）。
 *
 * 【关键语义变更】普通墓碑的「有效性」由**所在分片月份**决定，不再按 updatedAt 裁剪：
 *  - 读取窗口固定为「当月 + 上月」两个分片（当月 404 时补读下月，吸收月界时钟偏移）；
 *  - 因此「归档一条 updatedAt 在 180 天外的旧任务」时写出的墓碑**不会**被立刻裁掉
 *    （旧实现 pruneTombstones 按 updatedAt 裁，会让这条防复活证据当场失效）；
 *  - 代价：防复活窗口从 180 天收缩到 31~62 天（离线超两月的设备靠回收站近窗分片兜底）。
 *
 * 【未分类】projectId 为空串、拼不出 projects/<id>/ 目录，仍用用户级单文件
 *  today_tombstones.json（不分片；该路径只承接历史残留）。 */
/** 长周期 purged 库保留窗口（天）：日志为 KB 级，窗口远大于回收站分片的 2 个月 */
const PURGED_RETENTION_DAYS = 180
/** 墓碑三桶快照（供回滚还原）：分片（按月份）+ 长库 + 是否已加载 */
export interface TombstoneSnapshot {
  shards: Record<string, TombstoneEntry[]>
  purged: TombstoneEntry[]
  loaded: boolean
}
function tombstonesFilePath(username: string, projectId: string): string {
  // 未分类：用户级单文件（不分片）
  return projectId === UNCATEGORIZED ? paths.todayTombstones(username) : paths.tombstones(username, projectId)
}
/** 未分类的墓碑仍用单文件：projectId 为空串，返回 false 表示「不分片」 */
function tombstoneSharded(projectId: string): boolean {
  return projectId !== UNCATEGORIZED
}
function tombstoneShardPath(username: string, projectId: string, month: string): string {
  return paths.tombstonesShard(username, projectId, month)
}
function tombstoneShardCacheKey(username: string, projectId: string, month: string): string {
  return `tombshard:${username}:${projectId}:${month}`
}
function tombstoneShardEtagKey(username: string, projectId: string, month: string): string {
  return `etag:${username}:${projectId}:tomb:${month}`
}
function tombstonePurgedCacheKey(username: string, projectId: string): string {
  return `tombpurged:${username}:${projectId}`
}
function tombstonePurgedEtagKey(username: string, projectId: string): string {
  return `etag:${username}:${projectId}:tombpurged`
}
/** 普通墓碑读取窗口：当月 + 上月（升序）。当月分片 404 时调用方再补读下月。 */
function tombstoneWindowMonths(month: string): string[] {
  return [prevMonth(month), month]
}
/** 下一个自然月（2026-12 -> 2027-01），用于月界时钟偏移补偿 */
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}
/** 按 id 去重（同 id 保留 updatedAt 最新），不改顺序语义：用于分片内合并与写盘快照 */
function dedupeTombstones(entries: TombstoneEntry[] | undefined): TombstoneEntry[] {
  const byId = new Map<string, string>()
  for (const e of entries ?? []) {
    if (!e?.id) continue
    const cur = byId.get(e.id)
    if (!cur || (e.updatedAt || '').localeCompare(cur) > 0) byId.set(e.id, e.updatedAt)
  }
  return [...byId.entries()].map(([id, updatedAt]) => ({ id, updatedAt }))
}
/** 按保留窗口裁剪 purged 长库（按 id 去重、保留 updatedAt 最新，丢弃窗口外的条目）。
 *  只作用于 purged 桶：普通墓碑由分片月份决定生死，绝不再按 updatedAt 裁。 */
function pruneTombstones(entries: TombstoneEntry[] | undefined): TombstoneEntry[] {
  const cutoff = addDaysKey(todayKey(), -PURGED_RETENTION_DAYS)
  const byId = new Map<string, string>()
  for (const e of entries ?? []) {
    if (!e?.id) continue
    if (e.updatedAt < cutoff) continue
    const cur = byId.get(e.id)
    if (!cur || (e.updatedAt || '').localeCompare(cur) > 0) byId.set(e.id, e.updatedAt)
  }
  return [...byId.entries()].map(([id, updatedAt]) => ({ id, updatedAt }))
}
/** 「永久删除」墓碑的 id 命名空间前缀（见 types.ts TombstoneEntry 注释）。
 *  普通墓碑（真实任务 id）只挡住「活跃列表」的并集复活；永久删除再额外写一条 purged:<id>，
 *  让「回收站分片」的冲突并集合并也能剔除它——否则本端陈旧内存/IDB 缓存会把已永久删除的
 *  记录并回分片写进 OSS（多端复活）。 */
const PURGED_TOMBSTONE_PREFIX = 'purged:'
function purgedTombstoneId(taskId: string): string {
  return `${PURGED_TOMBSTONE_PREFIX}${taskId}`
}
/** 从墓碑条目里剥出「已永久删除」的真实任务 id（普通墓碑不参与） */
function purgedTaskIds(entries: TombstoneEntry[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const e of entries ?? []) {
    if (e?.id?.startsWith(PURGED_TOMBSTONE_PREFIX)) out.add(e.id.slice(PURGED_TOMBSTONE_PREFIX.length))
  }
  return out
}
/** 合并多组墓碑（同 id 保留 updatedAt 最新），返回可直接交给 applyDeletedTombstones 的 Task 形态。
 *  purged:<id> 是永久删除的命名空间标记，不是任务 id，必须排除，避免污染活跃列表的剔除集合。 */
function mergeTombstoneTasks(...groups: Array<TombstoneEntry[] | Task[] | undefined>): Task[] {
  const byId = new Map<string, string>()
  for (const group of groups) {
    for (const t of group ?? []) {
      if (!t?.id) continue
      if (t.id.startsWith(PURGED_TOMBSTONE_PREFIX)) continue
      const cur = byId.get(t.id)
      if (!cur || (t.updatedAt || '').localeCompare(cur) > 0) byId.set(t.id, t.updatedAt)
    }
  }
  return [...byId.entries()].map(([id, updatedAt]) => ({ id, updatedAt } as Task))
}
/** 合并两组墓碑条目（含 purged:<id> 永久删除命名空间），同 id 保留 updatedAt 最新。
 *  与 mergeTombstoneTasks 不同：保留 purged 条目（它们同样是防复活证据，供回收站分片
 *  冲突并集合并时剔除），用于 fetchTombstones 把「远端日志」与「本地未落盘墓碑」并集合并。 */
function mergeTombstoneEntries(a: TombstoneEntry[] | undefined, b: TombstoneEntry[] | undefined): TombstoneEntry[] {
  const byId = new Map<string, string>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!e?.id) continue
    const cur = byId.get(e.id)
    if (!cur || (e.updatedAt || '').localeCompare(cur) > 0) byId.set(e.id, e.updatedAt)
  }
  return [...byId.entries()].map(([id, updatedAt]) => ({ id, updatedAt }))
}
/** 本端是否存在「尚未落盘」的墓碑（防抖排队 / 写盘失败待重试 / 写盘在途）。
 *  用于 fetchTombstones 决定远端日志是否可直接覆盖本地缓存：
 *  有未落盘墓碑时只能并集合并，否则本地删除证据会被陈旧远端抹掉。 */
function hasPendingTombstones(projectId: string): boolean {
  return tombstonesSaving.has(projectId) || (tombstoneDebouncers.get(projectId)?.isPending() ?? false)
}
/** IDB 缓存键：任务按 用户名 + 项目ID 命名，避免跨账号残留脏数据 */
function taskCacheKey(username: string, projectId: string): string {
  return `tasks:${username}:${projectId}`
}
/** 回收站 IDB 缓存键：真实项目带月份后缀（trash:user:pid:YYYY-MM），未分类沿用单键 */
function trashCacheKey(username: string, projectId: string, month?: string): string {
  return `trash:${username}:${projectId}${month ? `:${month}` : ''}`
}
/** 任务所属回收站分片月份：按 updatedAt 所在月（YYYY-MM）确定归属，写入后不挪片 */
function monthOfTask(t: Task): string {
  const m = dateKeyOf(t.updatedAt || '').slice(0, 7)
  return m && m.length === 7 ? m : monthOfNow()
}
function monthOfNow(): string {
  return dateKeyOf(nowIso()).slice(0, 7)
}
/** 上一个自然月（2026-01 -> 2025-12） */
function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}
/** 回收站分片在 trashLoaded 中的标记键：pid:YYYY-MM */
function trashShardKey(projectId: string, month: string): string {
  return `${projectId}:${month}`
}
/** 重复模板存放路径（与任务文件一致：未分类 -> today_repeats.json） */
function repeatsFilePath(username: string, projectId: string): string {
  return projectId === UNCATEGORIZED ? paths.todayRepeats(username) : paths.repeats(username, projectId)
}
/** IDB 缓存键：重复模板按 用户名 + 项目ID 命名，避免跨账号残留 */
function repeatsCacheKey(username: string, projectId: string): string {
  return `repeats:${username}:${projectId}`
}
/** 今日任务跨项目顺序表：独立文件 today_order.json，记录今日可见任务的全局拖拽顺序 */
function todayOrderFilePath(username: string): string {
  return paths.todayOrder(username)
}
function todayOrderCacheKey(username: string): string {
  return `todayOrder:${username}`
}
function todayOrderEtagKey(username: string): string {
  return `etag:${username}:today_order`
}
function isServerEmptyError(e: unknown): boolean {
  const err = e as { code?: string | number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket'
}
/**
 * 排序活跃任务：pending 在前、其余置后。
 * 统一排序链：手动 sort > 提醒时间 > 开始时间 > 创建时间（升序；缺失键排后，endTime 不参与）。
 * 拖拽过（有 sort）的任务按 sort 升序（含重复任务——手动拖拽位置最高优先，被拖过的重复任务
 * 停留在拖拽后的位置，哪怕在普通任务中间/上方）；未拖过的按「普通任务在前、重复任务在后」
 * 分组，组内再走统一时间链（重复任务即使带提醒/开始/截止时间也不参与普通任务的排序竞争）。
 */
function sortActiveList(list: Task[]): Task[] {
  const cmp = (a: Task, b: Task) => {
    const ma = a.sort ?? Number.MAX_SAFE_INTEGER
    const mb = b.sort ?? Number.MAX_SAFE_INTEGER
    if (ma !== mb) return ma - mb
    return compareAutoTasks(a, b)
  }
  const pending = list.filter((t) => t.status === 'pending').sort(cmp)
  const rest = list.filter((t) => t.status !== 'pending').sort(cmp)
  return [...pending, ...rest]
}
/** 排序时间键（用于“本次编辑是否改了时间”的判定）：截到分钟再比。
 *  表单往返是 toLocalInput(slice(0,16)) → fromLocalInput，秒与时区后缀会被抹掉，
 *  直接比原始字符串会把「只改了描述」误判成「改了时间」，从而把任务弹离手动位置。
 *  空值统一为 null，避免 null / '' / undefined 被判成不同。 */
function sortTimeKey(v?: string | null): string | null {
  return v ? v.slice(0, 16) : null
}
function ensureDebouncer(store: ReturnType<typeof useTasksStore>, projectId: string) {
  if (!saveDebouncers.has(projectId)) {
    saveDebouncers.set(
      projectId,
      debounce(() => {
        void store.saveProject(projectId)
      }, 800),
    )
  }
  return saveDebouncers.get(projectId)!
}
function ensureTrashDebouncer(store: ReturnType<typeof useTasksStore>, projectId: string) {
  if (!trashDebouncers.has(projectId)) {
    trashDebouncers.set(
      projectId,
      debounce(() => {
        void store.saveTrash(projectId)
      }, 800),
    )
  }
  return trashDebouncers.get(projectId)!
}
function ensureTombstoneDebouncer(store: ReturnType<typeof useTasksStore>, projectId: string) {
  if (!tombstoneDebouncers.has(projectId)) {
    tombstoneDebouncers.set(
      projectId,
      debounce(() => {
        void store.saveTombstones(projectId).then((ok) => {
          // 写盘失败自动重排防抖重试：墓碑是防复活证据，必须最终落盘。
          // 否则失败后 isPending 变 false，fetchTombstones 会把本地未落盘墓碑当作
          // 陈旧数据覆盖掉，删除的任务会在重启后"复活"（BUG 根因之一）。
          if (!ok) ensureTombstoneDebouncer(store, projectId)()
        })
      }, 800),
    )
  }
  return tombstoneDebouncers.get(projectId)!
}
/** 将混合了回收站任务的旧数据拆分为活跃 / 回收站两份 */
function splitDeleted(list: Task[]): { active: Task[]; deleted: Task[] } {
  const active: Task[] = []
  const deleted: Task[] = []
  for (const t of list) {
    if (t.status === 'deleted') deleted.push(t)
    else active.push(t)
  }
  return { active, deleted }
}
/**
 * 跨项目去重：同 id 任务若在其它“已加载”项目中存在更新（updatedAt 更大）的副本，
 * 则本文件里的这份视为过期副本丢弃。
 *
 * 跨项目移动时目标项目副本的 updatedAt 恒比源项目残留副本新，因此轮询/CAS 冲突合并
 * 若把移动前读到的旧副本“复活”回源项目，此处能按最新归属收敛到唯一一份（BUG）。
 * 仅比较已加载项目，未加载项目由 projectId 过滤与后续同步自愈兜底。
 *
 * 归属判定（防误删）：副本必须“明确属于其它项目”（o.projectId === 副本所在项目 pid）
 * 才视为该任务已移走；projectId 缺失/指向本项目/指向第三方的副本不参与判定，避免
 * 把仍归属本项目的正常任务误判为过期副本剔除（BUG：来回拖拽子任务后任务“消失”）。
 */
function filterStaleAcrossProjects(
  allTasks: Record<string, Task[]>,
  projectId: string,
  tasks: Task[],
): Task[] {
  if (!tasks.length) return tasks
  // 收集其它项目中“明确归属该其它项目”的同 id 副本（projectId 与所在项目一致才视为已移走）
  const movedElsewhere = new Map<string, string>()
  for (const [pid, list] of Object.entries(allTasks)) {
    if (pid === projectId) continue
    for (const t of list) {
      // 副本明确属于它所在的项目 → 该 id 已被移往其它项目
      if (t.projectId === pid) {
        const cur = movedElsewhere.get(t.id)
        if (!cur || (t.updatedAt || '').localeCompare(cur) > 0) movedElsewhere.set(t.id, t.updatedAt)
      }
    }
  }
  if (!movedElsewhere.size) return tasks
  return tasks.filter((t) => {
    const otherUpdatedAt = movedElsewhere.get(t.id)
    if (!otherUpdatedAt) return true
    // 仅当其它项目副本 updatedAt 严格更新时才丢弃本项目这份（防时间相等/落后时误删）
    return (otherUpdatedAt.localeCompare(t.updatedAt || '') <= 0)
  })
}
/**
 * 跨项目去重（异步版）：在同步写回 / CAS 冲突合并 / 保存前，除内存中已加载项目外，
 * 再从本地 IDB 缓存读取「未加载 / 已被 LRU 逐出」项目的任务副本做比对：
 * 若其它项目缓存里存在比本份 updatedAt 更新的同 id 副本（任务已被移到其它项目），
 * 则本份视为过期副本丢弃，避免把已移走的任务旧副本写回源项目（BUG：移动任务被复制一份）。
 *
 * 只查本设备已有缓存的项目——从未缓存过目标项目的设备无法感知移动，但一旦同步/加载过
 * 目标项目即可拦截；与内存版 filterStaleAcrossProjects 语义一致，IDB 不可用/无其它缓存时
 * 退化为纯内存比对，不改变原行为。读取仅取 id/updatedAt 做轻量比对，不改写缓存。
 */
async function filterStaleAcrossProjectsAsync(
  allTasks: Record<string, Task[]>,
  projectId: string,
  tasks: Task[],
  username: string,
): Promise<Task[]> {
  const result = filterStaleAcrossProjects(allTasks, projectId, tasks)
  if (!result.length || !username) return result
  const loadedPids = new Set(Object.keys(allTasks))
  let cachedPids: string[] = []
  try {
    const prefix = `tasks:${username}:`
    const keys = await idbListKeys('tasks', prefix)
    for (const key of keys) {
      const pid = key.slice(prefix.length)
      // 未分类缓存（pid 为空）不承载活跃任务；已加载项目由内存版比对，跳过
      if (pid && pid !== projectId && !loadedPids.has(pid)) cachedPids.push(pid)
    }
  } catch {
    return result // IDB 不可用时退化为内存比对
  }
  if (!cachedPids.length) return result
  const byId = new Map(result.map((t) => [t.id, t]))
  const staleIds = new Set<string>()
  for (const pid of cachedPids) {
    const cached = await idbGet<Task[]>('tasks', taskCacheKey(username, pid))
    if (!cached || !cached.length) continue
    for (const t of cached) {
      const cur = byId.get(t.id)
      // 与内存版一致：仅“明确归属该缓存项目”的副本参与判定，防误删仍归属本项目的任务
      if (cur && t.projectId === pid && (t.updatedAt || '').localeCompare(cur.updatedAt || '') > 0) {
        staleIds.add(t.id)
      }
    }
  }
  if (!staleIds.size) return result
  return result.filter((t) => !staleIds.has(t.id))
}
/**
 * 按 id 定位任务：优先返回「归属明确」的副本（projectId 与所在项目数组一致），
 * 否则返回 updatedAt 最新的一份；preferPid 提供时（单项目视图）直接锁定该数组。
 *
 * 不用 this.all.find 的原因：this.all 是跨项目按 updatedAt 收敛的聚合，同 id 若在
 * 多个项目数组残留脏副本时会命中“另一项目”的副本，导致 convert/promote 作用于
 * 错误项目的任务对象（BUG：来回拖拽子任务/主任务后任务在视图里消失）。
 */
function findTaskByIdAcrossProjects(
  allTasks: Record<string, Task[]>,
  id: string,
  preferPid?: string,
): Task | undefined {
  if (preferPid) {
    const hit = (allTasks[preferPid] ?? []).find((t) => t.id === id)
    if (hit) return hit
  }
  let owned: Task | undefined
  let latest: Task | undefined
  for (const [pid, list] of Object.entries(allTasks)) {
    const t = list.find((x) => x.id === id)
    if (!t) continue
    // 归属明确（projectId === 所在数组）的副本是权威归属；记录 updatedAt 最新兜底
    if (t.projectId === pid) {
      if (!owned || (t.updatedAt || '').localeCompare(owned.updatedAt || '') > 0) owned = t
    } else if (!latest || (t.updatedAt || '').localeCompare(latest.updatedAt || '') > 0) {
      latest = t
    }
  }
  return owned ?? latest
}
/** 有界并发 map：限制同时执行的异步任务数，避免回收站分片全量拉取时一次性打满网络/连接池。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/** 拉取远端单个回收站文件（真实项目某月分片 / 未分类单文件）；文件不存在时视为空，网络/权限错误向上抛。
 *  带 Last-Modified 条件 GET（If-Modified-Since）：远端未变化返回 304 时直接复用本地缓存，避免每次同步都全量下载
 *  （回收站按月分片后日常只碰当月 + 上月两个小文件）。 */
async function fetchRemoteTrashShard(
  client: OssClient,
  username: string,
  projectId: string,
  month?: string,
): Promise<Task[]> {
  const etagKey = `etag:${username}:${projectId}:trash${month ? `:${month}` : ''}`
  const lmKey = lmKeyOf(etagKey)
  const cacheKey = trashCacheKey(username, projectId, month)
  // 阿里云 OSS 对 If-None-Match（ETag 条件 GET）不识别（实测带 Content-MD5 hex 永远回 200 全量），
  // 但对 If-Modified-Since 能正确回 304。因此读路径改用 Last-Modified 做条件请求；
  // etag 键仍保留给 CAS 写路径（compareAndSwapPut 复用同一键做冲突检测），两者互不覆盖。
  const lm = await idbGet<string>('kv', lmKey)
  try {
    const res = await client.get(
      trashFilePath(username, projectId, month),
      lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
    )
    if (res.res.status === 304) {
      // 远端未变化：复用本地回收站缓存（无缓存视为空）
      const cached = await idbGet<Task[]>('trash', cacheKey)
      return cached ?? []
    }
    if (res.res.status === 404) {
      await idbDel('kv', etagKey)
      await idbDel('kv', lmKey)
      return []
    }
    const list = JSON.parse(res.content.toString()) as Task[]
    normalizeTasks(list)
    const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
    if (newEtag) await idbPut('kv', etagKey, newEtag)
    const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
    if (newLm) await idbPut('kv', lmKey, newLm)
    await idbPut('trash', cacheKey, list)
    return list
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') {
      await idbDel('kv', etagKey)
      await idbDel('kv', lmKey)
      return []
    }
    // ali-oss 对 304 可能抛异常而非正常返回：与 loadProject/loadTrash 一致地兜底
    if (err.code === 304 || err.status === 304) {
      const cached = await idbGet<Task[]>('trash', cacheKey)
      return cached ?? []
    }
    throw e
  }
}

/** 回收站墓碑合并窗口：未分类拉单文件；真实项目拉当月 + 上月分片合并（日常只碰两个小文件），
 *  更早分片不参与登录/轮询的全量同步，避免回收站历史增长拖慢日常操作。 */
async function fetchRemoteTrash(client: OssClient, username: string, projectId: string): Promise<Task[]> {
  if (projectId === UNCATEGORIZED) return fetchRemoteTrashShard(client, username, projectId)
  const cur = monthOfNow()
  const prev = prevMonth(cur)
  const [a, b] = await Promise.all([
    fetchRemoteTrashShard(client, username, projectId, cur),
    fetchRemoteTrashShard(client, username, projectId, prev),
  ])
  return mergeUnique(a, b)
}

/** 旧版 projects/{pid}/trash.json 迁移：检测到旧文件且 trash/ 目录内无分片时，按 updatedAt 拆月写入分片，
 *  全部成功后才删除旧文件；失败/网络异常保留旧文件下次重试。迁移完成标记存 IDB，避免每次打开重复检查。 */
async function migrateLegacyTrash(client: OssClient, username: string, projectId: string): Promise<void> {
  // 空用户名（凭证已就绪但会话用户名尚未就绪的竞态窗口 / 旧版本残留）必须直接跳过：
  // 否则会把旧文件拆分成 users//projects/... 的空用户名分片（历史“空文件夹”数据的直接来源）
  if (!username) return
  const flagKey = `trashMigrated:${username}:${projectId}`
  // 未分类回收站只有 today_trash.json，不存在旧版 projects//trash.json，跳过旧回收站迁移
  if (projectId === UNCATEGORIZED) return
  if (await idbGet<boolean>('kv', flagKey)) return
  let oldList: Task[] | null = null
  try {
    const res = await client.get(paths.trash(username, projectId))
    if (res.res.status !== 404) {
      oldList = JSON.parse(res.content.toString()) as Task[]
      normalizeTasks(oldList)
    }
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') {
      // 旧文件不存在：直接标记完成
    } else {
      return // 网络/权限错误：本次跳过，下次再试
    }
  }
  if (oldList === null || !oldList.length) {
    // 旧文件不存在（或为空残留）：顺手删除空文件后标记完成
    if (oldList) await client.delete(paths.trash(username, projectId)).catch(() => {})
    await idbPut('kv', flagKey, true)
    return
  }
  // 按 updatedAt 拆月，把旧文件内容合并进对应分片（分片已存在则合并，避免覆盖新数据）
  const byMonth = new Map<string, Task[]>()
  for (const t of oldList) {
    const m = monthOfTask(t)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(t)
  }
  for (const [m, tasks] of byMonth) {
    const remote = await fetchRemoteTrashShard(client, username, projectId, m).catch(() => [] as Task[])
    const merged = mergeUnique(remote, tasks)
    const putRes = await client.put(paths.trashShard(username, projectId, m), JSON.stringify(merged))
    const etag = versionToken(putRes.res.headers as Record<string, unknown>, merged) ?? ''
    if (etag) await idbPut('kv', `etag:${username}:${projectId}:trash:${m}`, etag)
    await idbDel('kv', lmKeyOf(`etag:${username}:${projectId}:trash:${m}`))
    await idbPut('trash', trashCacheKey(username, projectId, m), merged)
  }
  await client.delete(paths.trash(username, projectId))
  await idbPut('kv', flagKey, true)
}

/** 按月分组回收站任务（YYYY-MM -> tasks） */
function groupTrashByMonth(list: Task[]): Map<string, Task[]> {
  const byMonth = new Map<string, Task[]>()
  for (const t of list) {
    const m = monthOfTask(t)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(t)
  }
  return byMonth
}

/** 枚举某项目 trash/ 目录下已存在的分片月份（升序）；目录不存在返回 [] */
async function listTrashShardMonths(client: OssClient, username: string, projectId: string): Promise<string[]> {
  const months = new Set<string>()
  let marker: string | undefined
  do {
    const query: Record<string, string | number> = {
      prefix: paths.trashShardPrefix(username, projectId),
      'max-keys': 1000,
    }
    if (marker) query.marker = marker
    const res = await client.list(query as never, {} as never)
    for (const obj of res.objects ?? []) {
      const m = /\/trash\/(\d{4}-\d{2})\.json$/.exec(obj.name)
      if (m) months.add(m[1])
    }
    marker = res.isTruncated && res.nextMarker ? res.nextMarker : undefined
  } while (marker)
  return [...months].sort()
}
function mergeUnique(base: Task[], incoming: Task[]): Task[] {
  const seen = new Set(base.map((t) => t.id))
  return [...base, ...incoming.filter((t) => !seen.has(t.id))]
}
/**
 * 重复模板合并（R4 修复：墓碑感知 + last-writer-wins，替代按 id 简单并集）：
 * - 同一 id 两端都存在：
 *   · 任一为墓碑（deletedAt）→ 墓碑优先，除非另一侧是「删除后明确复活」
 *     （存活副本 updatedAt 严格新于墓碑 deletedAt）；
 *   · 均存活 → updatedAt 更新者胜（平局本地胜，与 mergeTasks 同语义）；
 * - 仅一端存在 → 保留该端：新建或墓碑。墓碑继续随文件传播删除，
 *   直到所有端都合并过一次后，双端墓碑相遇时被 GC 掉（不会无限增长）。
 * 解决：一端删除重复规则（写墓碑）后，离线端缓存的旧 master 不再被并集合并写回复活。
 */
function mergeRepeatMasters(local: RepeatMaster[], remote: RepeatMaster[]): RepeatMaster[] {
  const byId = new Map<string, { l?: RepeatMaster; r?: RepeatMaster }>()
  for (const m of local) {
    const e = byId.get(m.id) ?? {}
    e.l = m
    byId.set(m.id, e)
  }
  for (const m of remote) {
    const e = byId.get(m.id) ?? {}
    e.r = m
    byId.set(m.id, e)
  }
  const out: RepeatMaster[] = []
  for (const { l, r } of byId.values()) {
    if (!l) {
      if (r) out.push(r)
      continue
    }
    if (!r) {
      out.push(l)
      continue
    }
    const lDead = !!l.deletedAt
    const rDead = !!r.deletedAt
    if (lDead && rDead) continue // 双端墓碑：删除已传播到所有合并过的端，GC 掉
    if (lDead) {
      // 本地墓碑 vs 远端存活：远端若在删除之后编辑过（复活）则保留远端，否则墓碑胜
      out.push(r.updatedAt > (l.deletedAt ?? '') ? r : l)
      continue
    }
    if (rDead) {
      // 远端墓碑 vs 本地存活（R4 复活场景）：本地若在删除之后编辑过（复活）则保留本地，否则墓碑胜
      out.push(l.updatedAt > (r.deletedAt ?? '') ? l : r)
      continue
    }
    out.push(l.updatedAt >= r.updatedAt ? l : r)
  }
  return out
}
/** 重复任务某条出现所在日（YYYY-MM-DD）：以提醒/截止/开始时间中最先出现的日期为准；
 *  全部为空时返回 ''（无法判定出现日，不参与同日去重）。 */
function occurrenceDayOf(t: Task): string {
  return dateKeyOf(t.reminderTime || t.endTime || t.startTime || '')
}
/** 把一条「异常多出的 pending 重复任务」转回重复模板（RepeatMaster）：
 *  它本质是某次未来出现被物化/恢复了两次，转回模板后由模板在下一次到期时再物化。
 *  master.id 用该出现自己的 id（保证与链上其它 master 不冲突）；sourceTaskId/rootTaskId
 *  指向链根，删除根任务时能一并清理。 */
function masterFromActiveTask(t: Task, day: string): RepeatMaster {
  const now = nowIso()
  return {
    id: t.id,
    projectId: t.projectId,
    sourceTaskId: rootIdOf(t),
    rootTaskId: rootIdOf(t),
    dueDate: day,
    template: { ...t, status: 'pending', isReminded: false, repeatOccurrence: undefined },
    createdAt: now,
    updatedAt: now,
  }
}
/** 重复任务自愈去重（重复任务 Bug 兜底）：同一重复链内出现多条「重复日」活动任务时收敛为一条。
 *  - 规则 A（同日重复）：同根 + 同规则 + 同出现日的多条活动任务 → 保留 updatedAt 最新，
 *    其余作为 deleted 墓碑返回（由调用方写入回收站，配合 applyDeletedTombstones 防复活）；
 *  - 规则 B（同链多 pending）：同根 + 同规则 的多条 pending 活动任务是异常态
 *    （正常流程同链至多一条 pending）→ 保留出现日最早的一条（当前出现），把较晚出现
 *    转回 RepeatMaster 模板（返回 masters，由调用方写回 repeats.json），不再作为活动任务。
 *  返回 { list, tombstoned, masters }。 */
function dedupRepeatOccurrences(list: Task[]): { list: Task[]; tombstoned: Task[]; masters: RepeatMaster[] } {
  const tombstoned: Task[] = []
  const masters: RepeatMaster[] = []
  const active = list.filter((t) => t.status !== 'deleted' && t.repeat)
  if (active.length < 2) return { list, tombstoned, masters }
  // 按 (链根, 规则指纹) 分组
  const byChain = new Map<string, Task[]>()
  for (const t of active) {
    const key = `${rootIdOf(t)}\u0000${repeatRuleFingerprint(t.repeat!)}`
    if (!byChain.has(key)) byChain.set(key, [])
    byChain.get(key)!.push(t)
  }
  const toDrop = new Set<string>()
  for (const chain of byChain.values()) {
    if (chain.length < 2) continue
    // 规则 A：同日多条 → 保 updatedAt 最新，其余入回收站墓碑
    const byDay = new Map<string, Task[]>()
    for (const t of chain) {
      const day = occurrenceDayOf(t)
      if (!day) continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day)!.push(t)
    }
    for (const same of byDay.values()) {
      if (same.length < 2) continue
      const keeper = same.reduce((a, b) =>
        (b.updatedAt || '').localeCompare(a.updatedAt || '') > 0 ? b : a,
      )
      for (const t of same) {
        if (t !== keeper && !toDrop.has(t.id)) {
          toDrop.add(t.id)
          tombstoned.push(t)
        }
      }
    }
    // 规则 B：同链多条 pending（异常态）→ 保留出现日最早的一条，较晚出现转回模板（不入回收站）
    const pending = chain.filter((t) => t.status === 'pending')
    if (pending.length > 1) {
      pending.sort((a, b) => (occurrenceDayOf(a) || '').localeCompare(occurrenceDayOf(b) || ''))
      const keeper = pending[0]
      for (const t of pending.slice(1)) {
        if (toDrop.has(t.id)) continue
        const day = occurrenceDayOf(t)
        if (!day) continue
        toDrop.add(t.id)
        masters.push(masterFromActiveTask(t, day))
      }
    }
  }
  if (!toDrop.size) return { list, tombstoned, masters }
  return { list: list.filter((t) => !toDrop.has(t.id)), tombstoned, masters }
}
function flushAllPendingSaves() {
  for (const fn of tombstoneDebouncers.values()) fn.flush()
  for (const fn of saveDebouncers.values()) fn.flush()
  for (const fn of trashDebouncers.values()) fn.flush()
  const tasks = useTasksStore()
  // 今日顺序表不在防抖器里（它是即时异步写）：页面隐藏/被杀前必须补一次，
  // 否则「拖拽后的顺序只在 IDB、云端还是旧值」，重启就会被旧云端覆盖回原样。
  void tasks.flushTodayOrder()
  // BUG-1 修复：防抖 300ms 内关闭页面会让 syncReminderTimer 丢失、提醒清单不上报。
  // 页面隐藏/关闭前尽力补报一次；若此刻请求被页面卸载中止，待报标记已落盘，下次登录由轮询补报。
  if (tasks.hasAny()) void tasks.syncReminders()
}
// 页面隐藏/关闭前尽量落盘，减少“防抖 800ms 内关闭导致 OSS 未保存”的数据丢失
if (typeof window !== 'undefined') {
  const onHide = () => flushAllPendingSaves()
  window.addEventListener('pagehide', onHide)
  window.addEventListener('beforeunload', onHide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllPendingSaves()
  })
  // 跨天自动归档：每分钟检测一次日期，跨天后把昨日完成的已完成任务移入回收站
  let lastDay = todayKey()
  window.setInterval(() => {
    const d = todayKey()
    if (d !== lastDay) {
      lastDay = d
      void useTasksStore().sweepCompleted()
      void useTasksStore().materializeRepeats()
      // 跨天统一对账：未来日期任务在今天首次可见 → 按时间登记进今日顺序表
      void useTasksStore().reconcileTodayOrder()
    }
  }, 60_000)
}

/**
 * F3 写前队列：最近一次「已排期但可能未落盘」的脏项目集合，持久化在 IDB kv。
 * 页面隐藏/关闭/被杀时未完成的防抖保存，由下次启动 finalizeSyncCatchUp 重放
 * （force 重跑 syncProject，合并语义保证不会用空/陈旧数据覆盖远端）。
 */
const DIRTY_KEY_PREFIX = 'dirty:'

function dirtyPidsKey(username: string): string {
  return `${DIRTY_KEY_PREFIX}${username}`
}

/** 内存缓存（会话内同一用户只读一次 IDB；mark/clear 的读写都基于该缓存）。
 *  按用户名缓存，避免登出切换账号时串号。 */
const dirtyPidsCache: Map<string, Set<string>> = new Map()

async function loadDirtyPids(username: string): Promise<string[]> {
  if (!username || typeof window === 'undefined') return []
  const cached = dirtyPidsCache.get(username)
  if (cached) return [...cached]
  const pids = (await idbGet<string[]>('kv', dirtyPidsKey(username))) ?? []
  dirtyPidsCache.set(username, new Set(pids))
  return [...dirtyPidsCache.get(username)!]
}

async function saveDirtyPids(username: string, pids: string[]): Promise<void> {
  dirtyPidsCache.set(username, new Set(pids))
  if (!username || typeof window === 'undefined') return
  if (pids.length) await idbPut('kv', dirtyPidsKey(username), pids)
  else await idbDel('kv', dirtyPidsKey(username))
}

/** 「设为子任务」撤销快照：记录转换前的归属/顺序/状态，供 undoSubtaskConversion 还原 */
interface SubtaskConversionSnapshot {
  sourceId: string
  targetId: string
  srcPid: string
  dstPid: string
  srcIndex: number
  srcSort: number | undefined
  srcStatus: Task['status']
  srcIsReminded: boolean
  /** 在今日顺序表中的原位置（<0 表示不在表中） */
  todayIndex: number
}

/** 最近一次“设为子任务”转换的快照（一次只会发生一个拖拽转换，单例足够） */
let subtaskConversionSnapshot: SubtaskConversionSnapshot | null = null

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: {} as Record<string, Task[]>,
    trash: {} as Record<string, Task[]>,
    repeats: {} as Record<string, RepeatMaster[]>,
    /** 各项目近窗普通墓碑（内存态，防复活用）：项目 -> 分片月份 -> 条目。
     *  持久化在 OSS tombstones/{YYYY-MM}.json + IDB kv 缓存（tombpurged 为长库） */
    tombstoneShards: {} as Record<string, Record<string, TombstoneEntry[]>>,
    /** 各项目「永久删除」长周期墓碑（OSS tombstones.json，保留 180 天） */
    tombstonePurged: {} as Record<string, TombstoneEntry[]>,
    /** 已「从远端加载过」墓碑的项目（区分「未加载」与「已加载但为空」：
     *  不能用三桶是否为空来判断，否则 clearPurgedTombstones 会跳过读盘导致清不掉旧证据） */
    tombstonesLoaded: [] as string[],
    loadedProjects: [] as string[],
    trashLoaded: [] as string[],
    /** 各项目已合并进内存的回收站分片月份（升序，YYYY-MM；未分类不记录） */
    trashLoadedMonths: {} as Record<string, string[]>,
    /** 各项目 OSS 上检测到的回收站分片月份（来自扫描或按需枚举） */
    trashShardMonths: {} as Record<string, string[]>,
    /** 各项目是否还有更早分片可加载（驱动「加载更早」按钮显隐） */
    trashHasMore: {} as Record<string, boolean>,
    /** 已动态加载进内存的时间胶囊年份（多视图按需加载标记） */
    trashLoadedYears: [] as number[],
    /** 时间胶囊当前过滤年份（按年份过滤模式：整个时间胶囊页只展示这一年） */
    trashYear: null as number | null,
    repeatsLoaded: [] as string[],
    /** 今日任务跨项目拖拽顺序表（任务 id 全局有序；展示时按「今日可见 + 仍存在」过滤） */
    todayOrder: [] as string[],
    /** 今日顺序表的「权威值是否已就位」：只有成功读到云端（200）或用缓存当地权威（304/无凭证）
     *  时才为 true。置 false 期间禁止自动补登记/对账写回——否则冷启动会用半套数据（旧缓存或空表）
     *  算出一个新顺序并覆盖用户的手动拖拽位置（实锤现象：手动拖在最前的重复任务被排回末尾）。
     *  每次进入追平状态（setSyncCatchingUp）都会重置为 false，由 loadTodayOrder 重新置位。 */
    todayOrderLoaded: false,
    /** 今日顺序表最后一次「人工写入」时间（拖拽/对账落盘）。用于多端 CAS 冲突时判定谁更晚，
     *  并写入 today_order.json 供他端合并。旧数据缺失时按空串处理（视为最旧）。 */
    todayOrderUpdatedAt: '',
    /** 今日顺序表是否有「尚未成功上传」的人工顺序：为 true 时缓存保留 dirty 标记，
     *  由轮询/下次登录自动重试上传，避免 write 失败后本地与云端长期不一致（本地错、云端对）。 */
    todayOrderDirty: false,
    /** 未在内存命中的顺序表 id 的连续 miss 次数（内存态，不持久化）：连续两次对账都查不到才剔除，
     *  防止冷启动「项目尚未加载」这种瞬时状态把合法的已登记 id 当成死 id 删掉。 */
    todayOrderMisses: {} as Record<string, number>,
    /** 同步追平门闩（F0/F1）：置位期间禁止加载/同步期自动写回 OSS——今日顺序对账
     *  （reconcile/reposition）、自动归档、到期物化、自愈清理的落盘一律推迟；用户动作写
     *  （编辑/拖拽/完成/删除）不受影响。追平后由 finalizeSyncCatchUp 统一执行最终对账
     *  并冲刷被延迟的写回。 */
    syncCatchingUp: false,
    /** 追平门闩期间被延迟落盘的项目（自动写回：墓碑/回收站/任务/模板），追平后按
     *  「墓碑→回收站→任务→模板」顺序收敛（见 finalizeSyncCatchUp） */
    deferredWritebackProjects: [] as string[],
  }),
  getters: {
    /** 全部已加载任务（跨项目），按 id 去重：跨项目移动后同 id 的过期副本只保留 updatedAt 最新一份，
     *  避免同一个任务被渲染/操作两遍（BUG：重复任务显示）。 */
    all: (s) => dedupTasksById(Object.values(s.tasks).flat()),
    /** 全部回收站/时间胶囊任务（跨项目），同样按 id 去重（同 id 可能同时残留在新旧两个项目的回收站） */
    allTrash: (s) => dedupTasksById(Object.values(s.trash).flat()),
    byProject: (s) => (projectId: string) => s.tasks[projectId] ?? [],
    /** 今日任务侧栏角标：今日视图中可见的进行中任务数 */
    todayCount: (s) => {
      const today = todayKey()
      return dedupTasksById(Object.values(s.tasks).flat())
        .filter((t) => t.status === 'pending' && isTaskVisibleToday(t, today)).length
    },
    /** 侧栏头部：全部待办任务数（跨项目，仅统计内存中已加载的项目；
     *  与项目页主列表同口径：开始时间晚于今天（未来才开始）的任务不计入） */
    pendingCount: (s) => dedupTasksById(Object.values(s.tasks).flat()).filter((t) => t.status === 'pending' && isProjectTaskActiveToday(t, todayKey())).length,
    /** 侧栏头部：今天已完成任务数（跨项目；完成任务时 updatedAt 记为完成时间） */
    completedTodayCount: (s) => {
      const today = todayKey()
      return dedupTasksById(Object.values(s.tasks).flat())
        .filter((t) => t.status === 'completed' && dateKeyOf(t.updatedAt) === today).length
    },
    /** 今日相关项目：本地（IDB）缓存里存在“今日可见”任务的项目。
     *  登录/全量同步时只刷这些，其余项目打开时再由 loadProject 按需从 OSS 拉取。 */
    todayRelevantProjectIds: (s) => (projectIds: string[]) => {
      const today = todayKey()
      const set = new Set<string>()
      for (const id of projectIds) {
        if ((s.tasks[id] ?? []).some((t) => isTaskVisibleToday(t, today))) set.add(id)
        // 重复模板：未来 30 天内到期（含今天）的模板也纳入「今日相关」。
        // 否则「项目里只有重复模板、没有其他今日可见任务」时该项目不会被加载，
        // 到期模板无法物化，今日/未来任务区也就不会出现对应任务（BUG）。
        const last = addDaysKey(today, 30)
        if ((s.repeats[id] ?? []).some((m) => !m.deletedAt && m.dueDate <= last)) set.add(id)
      }
      return [...set]
    },
    /** 当前视图聚焦的项目 id（正在浏览的项目 / 回收站展开的项目），供手动同步一并刷新 */
    viewPinnedProjectIds: (s) => [...viewPins],
  },
  actions: {
    async loadProject(projectId: string) {
      if (projectId === UNCATEGORIZED) return
      this.touchProject(projectId)
      const auth = useAuthStore()
      if (this.loadedProjects.includes(projectId)) return
      // 同项目并发加载去重：ProjectView 的 onMounted 与路由 watch 会同时调用 loadProject，
      // 复用同一个 in-flight 请求，避免打开项目时重复下载该项目的 tasks/repeats 数据包。
      const inFlight = loadingProjectPromises.get(projectId)
      if (inFlight) return inFlight
      const p = this._loadProjectInner(projectId).finally(() => {
        loadingProjectPromises.delete(projectId)
      })
      loadingProjectPromises.set(projectId, p)
      return p
    },
    /** loadProject 的实际实现（由 loadProject 去重后调用）。 */
    async _loadProjectInner(projectId: string) {
      const auth = useAuthStore()
      const cached = await idbGet<Task[]>('tasks', taskCacheKey(auth.username, projectId))
      if (cached) {
        normalizeTasks(cached)
        const { active, deleted } = splitDeleted(cached)
        // 丢弃 projectId 与所在项目不一致的过期副本（跨项目移动残留），防止本地缓存复活
        const cachedActive = await filterStaleAcrossProjectsAsync(
          this.tasks,
          projectId,
          filterTasksForProject(active, projectId),
          auth.username,
        )
        // 自愈去重（仅内存 + IDB；OSS 由下方远端加载 / 后续同步收敛）：缓存里残留的
        // 同链重复日 / 同链多 pending 重复任务先收敛，避免打开瞬间就显示两条重复任务
        const { list: deduped, tombstoned, masters } = dedupRepeatOccurrences(cachedActive)
        this.tasks[projectId] = deduped
        await idbPut('tasks', taskCacheKey(auth.username, projectId), deduped)
        if (tombstoned.length) {
          this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], tombstoned)
          await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
        }
        if (masters.length) {
          const existing = this.repeats[projectId] ?? []
          this.repeats[projectId] = [...existing, ...masters.filter((m) => !existing.some((e) => e.id === m.id))]
          await idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId])
        }
        if (deleted.length) {
          this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], deleted)
          await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
          if (this.syncCatchingUp) {
            // F1：追平门闩——加载路径的回收站写回延迟到追平后统一收敛
            this.deferWriteback(projectId)
          } else {
            void this._persistTrash(projectId, true)
          }
        }
        // 墓碑日志：顺带读本地缓存（不标记已加载，远端由 syncProject/轮询刷新）
        if (!this.tombstonesReady(projectId)) {
          const cachedShard = await idbGet<TombstoneEntry[]>('kv', tombstoneShardCacheKey(auth.username, projectId, monthOfNow()))
          const cachedPurged = await idbGet<TombstoneEntry[]>('kv', tombstonePurgedCacheKey(auth.username, projectId))
          if (cachedShard?.length || cachedPurged?.length) {
            this.tombstoneShards[projectId] = {
              ...(this.tombstoneShards[projectId] ?? {}),
              [monthOfNow()]: cachedShard ?? [],
            }
            this.tombstonePurged[projectId] = cachedPurged ?? []
          }
        }
      }
      if (!auth.creds || !auth.username) {
        await this.sweepCompleted(projectId)
        return
      }
      const etagKey = `etag:${auth.username}:${projectId}`
      const lmKey = lmKeyOf(etagKey)
      try {
        const client = await createOssClient(auth.creds)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          tasksFilePath(auth.username, projectId),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as Task[]
          normalizeTasks(remote)
          const { active, deleted } = splitDeleted(remote)
          let remoteActive = await filterStaleAcrossProjectsAsync(
            this.tasks,
            projectId,
            filterTasksForProject(active, projectId),
            auth.username,
          )
          // 读路径应用墓碑（本地日志 + 远端日志回填/降级 + 本次任务文件里的 deleted）：
          // 清除本地残留的「已被他端完成/删除」的旧重复行，避免与物化出的新行并存为两条重复任务
          // （重复任务 Bug）。墓碑日志缺失时由 collectTombstones 回填/降级回收站近窗分片兜底。
          const tombstones = await this.collectTombstones(projectId, deleted)
          remoteActive = applyDeletedTombstones(remoteActive, tombstones)
          // 自愈去重：同链重复日 / 同链多 pending 收敛为一条（异常时写回收站 / repeats 落盘）
          remoteActive = await this._selfHealRepeatDuplicates(projectId, remoteActive)
          // 自愈孤儿副本：跨项目转成子任务后源项目残留的顶层旧副本（同 id 已作为某任务子任务）
          remoteActive = await this._selfHealOrphanSubtasks(projectId, remoteActive)
          this.tasks[projectId] = sortActiveList(remoteActive)
          // 跨天归档：非当天完成的已完成任务稍后由 sweepCompleted 统一移入回收站
          await idbPut('tasks', taskCacheKey(auth.username, projectId), this.tasks[projectId])
          if (deleted.length) {
            this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], deleted)
            await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
            if (this.syncCatchingUp) {
              // F1：追平门闩——加载路径的回收站写回延迟到追平后统一收敛
              this.deferWriteback(projectId)
            } else {
              void this._persistTrash(projectId, true)
            }
          }
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', etagKey, newEtag)
          const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
          if (newLm) await idbPut('kv', lmKey, newLm)
        }
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        const is304 = err.code === 304 || err.status === 304
        if (is304) {
          // 缓存与云端一致，无需处理
        } else if (isServerEmptyError(e)) {
          // 服务端该任务文件已不存在（bucket/文件被删除）：本地缓存作废，
          // 避免旧数据被当作权威展示，也避免下次编辑时把过期数据再次同步回云端
          this.tasks[projectId] = []
          await idbDel('tasks', taskCacheKey(auth.username, projectId))
          await idbDel('kv', etagKey)
          await idbDel('kv', lmKey)
        } else {
          throw new Error(await enrichOssError(e))
        }
      }
      // 跨天归档：加载后把非当天完成的已完成任务移入回收站
      await this.sweepCompleted(projectId)
      // 重复模板：加载后把到期模板物化为可见任务（模板删除，由物化任务承担后续周期）
      await this.loadRepeats(projectId)
      await this.materializeRepeats(projectId)
      this.loadedProjects.push(projectId)
    },
    /** 仅读 IndexedDB 本地缓存（不访问 OSS），用于侧栏角标等轻量场景。
     *  返回「本地已有任务缓存（含已在内存中）」的项目 id 列表：
     *  调用方据此判断本地缓存是否完整——不完整（全新设备/首次进入）时
     *  无法推断哪些项目今日有任务，必须全量加载所有项目，否则今日视图
     *  首次进入为空，直到手动点开项目才拉取数据。 */
    async loadFromIdb(projectIds: string[]): Promise<string[]> {
      const auth = useAuthStore()
      const cachedIds: string[] = []
      for (const id of projectIds) {
        this.touchProject(id)
        if (this.loadedProjects.includes(id)) {
          cachedIds.push(id)
          continue
        }
        const cached = await idbGet<Task[]>('tasks', taskCacheKey(auth.username, id))
        if (cached) {
          cachedIds.push(id)
          normalizeTasks(cached)
          const { active, deleted } = splitDeleted(cached)
          this.tasks[id] = active
          if (deleted.length) {
            this.trash[id] = mergeUnique(this.trash[id] ?? [], deleted)
            await idbPut('trash', trashCacheKey(auth.username, id), this.trash[id])
          }
        }
        // 重复模板：顺带读本地缓存（不标记 repeatsLoaded，加载项目时仍会从 OSS 刷新），
        // 供 todayRelevantProjectIds 识别「只有模板到期」的项目，触发物化
        if (this.repeats[id] === undefined) {
          const cachedRepeats = await idbGet<RepeatMaster[]>('repeats', repeatsCacheKey(auth.username, id))
          if (cachedRepeats) this.repeats[id] = cachedRepeats
        }
        // 墓碑日志：顺带读本地缓存（防复活依据，本地缓存即权威的离线视图）
        if (!this.tombstonesReady(id)) {
          const cachedShard = await idbGet<TombstoneEntry[]>('kv', tombstoneShardCacheKey(auth.username, id, monthOfNow()))
          const cachedPurged = await idbGet<TombstoneEntry[]>('kv', tombstonePurgedCacheKey(auth.username, id))
          if (cachedShard?.length || cachedPurged?.length) {
            this.tombstoneShards[id] = {
              ...(this.tombstoneShards[id] ?? {}),
              [monthOfNow()]: cachedShard ?? [],
            }
            this.tombstonePurged[id] = cachedPurged ?? []
          }
        }
      }
      return cachedIds
    },
    async loadAll(projectIds: string[]) {
      await Promise.all(projectIds.map((id) => this.loadProject(id)))
    },
    /** 渐进加载全部项目：每批 4 个并发，避免一次性全量并发压垮网络（今日视图等高频页面用） */
    async loadAllProgressive(projectIds: string[]) {
      const BATCH = 4
      for (let i = 0; i < projectIds.length; i += BATCH) {
        await Promise.all(projectIds.slice(i, i + BATCH).map((id) => this.loadProject(id)))
      }
    },
    /**
     * 加载今日任务跨项目顺序表：先恢复 IDB 缓存（保住本地手动位置），再条件 GET OSS。
     *
     * 关键语义（修复「重启后手动拖到最前的重复任务被排回末尾」）：
     *  - 云端与本地**合并**、绝不整表覆盖：以「更晚写入」的一方为基准，另一方多出的 id 按落点补入
     *    （见 mergeOrderIds 的三条不变量：不删、不挪、未知 id 保留）；
     *  - 304 / 无凭证：以本地缓存为权威（拖拽后的顺序就在缓存里），并置 todayOrderLoaded=true；
     *  - 本地 dirty（上次上传失败）：以本地为准并立即补传；
     *  - 成功拿到云端 200：置 todayOrderLoaded=true，之后才允许 reconcile 自动补登记；
     *  - 拉取异常不再静默吞掉：抛给调用方（轮询）判定失败、不推进游标，下一轮重试，
     *    避免「变更事件被消费但内容没拉到 → 本端永久陈旧」。
     */
    async loadTodayOrder(): Promise<void> {
      const auth = useAuthStore()
      const cacheKey = todayOrderCacheKey(auth.username)
      const cached = await idbGet<{ ids?: string[]; updatedAt?: string; dirty?: boolean }>('kv', cacheKey)
      const localIds = Array.isArray(cached?.ids) ? cached.ids : []
      const localDirty = !!cached?.dirty
      const localAt = cached?.updatedAt ?? ''
      // 先用本地缓存（可能带手动位置）；此时还不算「权威值就位」，禁止自动补登记
      if (localIds.length) this.todayOrder = localIds
      this.todayOrderUpdatedAt = localAt
      this.todayOrderDirty = localDirty
      if (!auth.creds || !auth.username) {
        // 离线/凭证未就绪：缓存即权威（拖拽后的顺序就在缓存里），允许按它补登记。
        // 缓存为空时也置 true：此时没有任何人工顺序可被覆盖，按规则重建整表是安全的。
        this.todayOrderLoaded = true
        return
      }
      try {
        const client = await createOssClient(auth.creds)
        const etagKey = todayOrderEtagKey(auth.username)
        const lmKey = lmKeyOf(etagKey)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          todayOrderFilePath(auth.username),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status === 304) {
          // 云端未变化 = 缓存即权威（缓存里是拖拽后的顺序，不会被旧云端抹掉）。
          // 缓存为空但条件 GET 命中 304（缓存被清过、Last-Modified 仍在）：无法判定内容，
          // 补一次无条件 GET 拿真实顺序，避免用空表按规则重建整表。
          if (!localIds.length) {
            const full = await client.get(todayOrderFilePath(auth.username))
            if (full.res.status !== 304) {
              const remote = JSON.parse(full.content.toString()) as { ids?: string[]; updatedAt?: string }
              this.todayOrder = Array.isArray(remote?.ids) ? remote.ids : []
              this.todayOrderUpdatedAt = remote?.updatedAt ?? ''
              await idbPut('kv', cacheKey, {
                ids: this.todayOrder,
                updatedAt: this.todayOrderUpdatedAt,
                dirty: false,
              })
              const newLm = lastModifiedOf(full.res.headers as Record<string, unknown>)
              if (newLm) await idbPut('kv', lmKey, newLm)
            }
            this.todayOrderLoaded = true
            return
          }
          this.todayOrderLoaded = true
          if (this.todayOrderDirty) void this.saveTodayOrderNow()
          return
        }
        const remote = JSON.parse(res.content.toString()) as { ids?: string[]; updatedAt?: string }
        const remoteIds = Array.isArray(remote?.ids) ? remote.ids : []
        const remoteAt = remote?.updatedAt ?? ''
        const byId = new Map(this.all.map((t) => [t.id, t]))
        const lookup = (id: string): Task | undefined => byId.get(id)
        // 谁更晚谁当基准：本地 dirty（待上传的人工顺序）或本地时间戳不早于远端 → 本地胜；
        // 双方都没有时间戳（老数据）时，有内容的一方胜（避免被空表覆盖）。
        const localWins =
          this.todayOrderDirty ||
          (!!localAt && localAt >= remoteAt) ||
          (!localAt && !remoteAt && localIds.length > 0 && remoteIds.length === 0)
        const base = localWins ? localIds : remoteIds
        const other = localWins ? remoteIds : localIds
        this.todayOrder = mergeOrderIds(base, other, lookup)
        this.todayOrderLoaded = true
        this.todayOrderUpdatedAt = localWins ? localAt : remoteAt
        this.todayOrderDirty = localWins && localDirty
        await idbPut('kv', cacheKey, {
          ids: this.todayOrder,
          updatedAt: this.todayOrderUpdatedAt,
          dirty: this.todayOrderDirty,
        })
        const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
        if (newEtag) await idbPut('kv', etagKey, newEtag)
        const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
        if (newLm) await idbPut('kv', lmKey, newLm)
        // 合并结果与云端不同（本地有更新的手动顺序 / 本地多出 id）→ 推上云
        if (this.todayOrder.join('|') !== remoteIds.join('|')) void this.saveTodayOrderNow()
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        // 文件不存在（首次使用/未拖拽过）或 304：云端确实没有顺序表 → 以本地缓存为准
        if (isServerEmptyError(e) || err.code === 304 || err.status === 304) {
          this.todayOrderLoaded = true
          if (this.todayOrderDirty) void this.saveTodayOrderNow()
          return
        }
        // 其它异常：保留本地手动顺序（不清空、不覆盖），标记「权威值未就位」禁止自动补登记，
        // 并把错误抛给调用方，让轮询不推进游标、下一轮重试。
        this.todayOrderLoaded = false
        console.error('加载今日任务顺序失败', e)
        throw e
      }
    },
    /** 项目被访问/加载时调用：更新 LRU 并把“最近最少使用”的非固定项目逐出内存 */
    touchProject(projectId: string) {
      const i = accessOrder.indexOf(projectId)
      if (i >= 0) accessOrder.splice(i, 1)
      accessOrder.unshift(projectId)
      void this.evictIfNeeded()
    },
    /** 当前视图聚焦的项目固定（正在浏览的项目 / 回收站展开的项目），由视图挂载/卸载时增删 */
    pinViewProject(projectId: string) {
      viewPins.add(projectId)
      this.touchProject(projectId)
    },
    unpinViewProject(projectId: string) {
      viewPins.delete(projectId)
      void this.evictIfNeeded()
    },
    /** 时间胶囊页打开期间固定全部项目：防止逐出导致日历图/项目图丢失已完成活跃任务。
     *  退出胶囊（releaseTrashMemory）时统一解除。 */
    pinCapsuleProjects(projectIds: string[]) {
      for (const id of projectIds) {
        capsulePins.add(id)
        this.touchProject(id)
      }
    },
    unpinCapsuleProjects(projectIds: string[]) {
      for (const id of projectIds) capsulePins.delete(id)
      void this.evictIfNeeded()
    },
    /** 打开时间胶囊时补全所有项目的活跃任务文件：已完成任务可能仍留在活跃列表（当天完成
     *  未归档），需一并读入内存才能在日历图/项目图显示完成状态。加载前先固定全部项目防止
     *  LRU 逐出；单项目失败不影响其它项目（下一轮打开会重试）。 */
    async loadCapsuleActiveProjects(): Promise<void> {
      const projectsStore = useProjectsStore()
      if (!projectsStore.loaded) await projectsStore.load().catch(() => {})
      const ids = projectsStore.projects.map((p) => p.id)
      this.pinCapsuleProjects(ids)
      const BATCH = 4
      for (let i = 0; i < ids.length; i += BATCH) {
        await Promise.all(
          ids.slice(i, i + BATCH).map(async (id) => {
            try {
              await this.loadProject(id)
            } catch {
              /* 单项目加载失败忽略：其已完成任务可能短暂缺失，但下一轮打开会重试 */
            }
          }),
        )
      }
    },
    /** 把“最近最少使用”的非固定项目逐出内存（仅内存与已加载标记；IDB 缓存保留，下次访问按需重载）。
     *  正在保存 / 有未落盘待发变更的项目不逐出，避免把内存数据写空到 OSS。 */
    async evictIfNeeded() {
      if (evicting || accessOrder.length <= MAX_RESIDENT_PROJECTS) return
      evicting = true
      try {
        const today = todayKey()
        const pins = new Set<string>([...viewPins, UNCATEGORIZED, ...capsulePins])
        // 活跃项目固定集不单独维护：凡内存里存在「今日可见任务」的项目都固定常驻，
        // 保证今日视图与侧栏角标始终完整；无今日任务的已访问项目按 LRU 逐出（内存上限生效）。
        for (const [pid, list] of Object.entries(this.tasks)) {
          if (list.some((t) => isTaskVisibleToday(t, today))) pins.add(pid)
        }
        let excess = accessOrder.filter((pid) => !pins.has(pid)).length - MAX_RESIDENT_PROJECTS
        // 从最近最少使用（尾部）开始逐出；保存中的项目跳过，等下一轮
        for (let i = accessOrder.length - 1; i >= 0 && excess > 0; i--) {
          const pid = accessOrder[i]
          if (pins.has(pid) || savingNow.has(pid)) continue
          // 有防抖待发（尚未落盘 OSS）的变更时，先立即落盘成功再逐出
          const pendingTasks = saveDebouncers.get(pid)?.isPending() ?? false
          const pendingTrash = trashDebouncers.get(pid)?.isPending() ?? false
          const pendingTombstones = tombstoneDebouncers.get(pid)?.isPending() ?? false
          if (pendingTasks || pendingTrash || pendingTombstones) {
            const okTasks = pendingTasks ? await this.saveProjectNow(pid) : true
            const okTrash = pendingTrash ? await this.saveTrashNow(pid) : true
            const okTombstones = pendingTombstones ? await this.saveTombstonesNow(pid) : true
            if (!okTasks || !okTrash || !okTombstones) continue // 落盘失败：保留内存，下一轮再试
          }
          accessOrder.splice(i, 1)
          this._evictProject(pid)
          excess--
        }
      } finally {
        evicting = false
      }
    },
    _evictProject(projectId: string) {
      delete this.tasks[projectId]
      delete this.trash[projectId]
      delete this.repeats[projectId]
      this.loadedProjects = this.loadedProjects.filter((x) => x !== projectId)
      this.trashLoaded = this.trashLoaded.filter((x) => x !== projectId)
      delete this.trashLoadedMonths[projectId]
      delete this.trashShardMonths[projectId]
      delete this.trashHasMore[projectId]
      this.repeatsLoaded = this.repeatsLoaded.filter((x) => x !== projectId)
    },
    /** 拉取回收站任务（按月分片，按需加载）。
     *  默认只加载「当月 + 上月」窗口（真实项目）或单文件（未分类），更早记录由「加载更早」按需拉取。
     *  force=true 用于轮询同步收到 trash 变更时强制刷新最近窗口。 */
    async loadTrash(projectId: string, force = false) {
      this.touchProject(projectId)
      const auth = useAuthStore()
      if (this.trashLoaded.includes(projectId) && !force) return
      const cached = await idbGet<Task[]>('trash', trashCacheKey(auth.username, projectId))
      if (cached) {
        normalizeTasks(cached)
        this.trash[projectId] = cached
        if (projectId !== UNCATEGORIZED) {
          // 缓存里可能含此前「加载更早」拉到的旧月份，一并标记为已加载
          const months = new Set(cached.map((t) => monthOfTask(t)))
          this.trashLoadedMonths[projectId] = [...months].sort()
        }
      }
      if (!auth.creds || !auth.username) {
        if (!this.trashLoaded.includes(projectId)) this.trashLoaded.push(projectId)
        return
      }
      try {
        const client = await createOssClient(auth.creds)
        // 旧版 projects/{pid}/trash.json 先迁移到按月分片（幂等，只做一次）
        await migrateLegacyTrash(client, auth.username, projectId)
        // 永久删除墓碑：合并远端前先取一次（条件 GET / 304 零下载）并剔除本端缓存里
        // 已被他端永久删除的记录——否则下面的并集合并会把它留在内存、随后被写回 OSS。
        await this.fetchTombstones(projectId, { backfill: false }).catch(() => [])
        await this._dropPurgedTrash(projectId)
        const remote = await fetchRemoteTrash(client, auth.username, projectId)
        if (remote.length) {
          this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], remote)
          // 远端仍残留已永久删除的记录（历史并集写回）：本地不入内存/缓存
          await this._dropPurgedTrash(projectId)
          await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
        }
        if (projectId !== UNCATEGORIZED) {
          // 刷新分片月份索引：确保未先扫描时「加载更早」按钮也能按需出现
          try {
            this.trashShardMonths[projectId] = await listTrashShardMonths(client, auth.username, projectId)
          } catch {
            /* 枚举失败保留已有索引 */
          }
          const cur = monthOfNow()
          const prev = prevMonth(cur)
          const months = new Set((this.trash[projectId] ?? []).map((t) => monthOfTask(t)))
          // 当月/上月即使为空也标记为已加载窗口，避免 saveTrash 每次重复拉远端
          months.add(cur)
          months.add(prev)
          this.trashLoadedMonths[projectId] = [...months].sort()
          this.trashHasMore[projectId] = (this.trashShardMonths[projectId] ?? []).some((m) => !months.has(m))
        } else {
          this.trashHasMore[projectId] = false
        }
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        const is304 = err.code === 304 || err.status === 304
        if (is304) {
          // 缓存与云端一致，无需处理
        } else if (isServerEmptyError(e)) {
          // 服务端回收站文件已不存在：本地回收站缓存作废
          this.trash[projectId] = []
          await idbDel('trash', trashCacheKey(auth.username, projectId))
          this.trashLoadedMonths[projectId] = []
          this.trashHasMore[projectId] = false
        } else {
          throw new Error(await enrichOssError(e))
        }
      }
      if (!this.trashLoaded.includes(projectId)) this.trashLoaded.push(projectId)
    },
    /** 「加载更早」：按需拉取更早月份的回收站分片并合并进内存（一次拉一个更早月份），
     *  返回是否拉到新记录；没有更多分片时置 trashHasMore=false。 */
    async loadMoreTrash(projectId: string): Promise<boolean> {
      const auth = useAuthStore()
      if (projectId === UNCATEGORIZED || !auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      const shards = await listTrashShardMonths(client, auth.username, projectId)
      this.trashShardMonths[projectId] = shards
      const loaded = new Set(this.trashLoadedMonths[projectId] ?? [])
      const notLoaded = shards.filter((m) => !loaded.has(m)).sort()
      if (!notLoaded.length) {
        this.trashHasMore[projectId] = false
        return false
      }
      // 优先补拉「比已加载窗口更早」且最接近的一个月；跨月后出现的新月份也一并补拉
      const oldestLoaded = loaded.size ? [...loaded].sort()[0] : undefined
      const older = oldestLoaded === undefined ? [] : notLoaded.filter((m) => m < oldestLoaded)
      const next = older.length ? older[older.length - 1] : notLoaded[notLoaded.length - 1]
      const remote = await fetchRemoteTrashShard(client, auth.username, projectId, next)
      if (remote.length) {
        this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], remote)
        // 「加载更早」同样先剔除已被他端永久删除的记录：本支路可能没走过 loadTrash，
        // 此时内存墓碑还没加载过，先取一次（条件 GET / 304 零下载）再过滤
        if (!this.tombstonesReady(projectId)) await this.fetchTombstones(projectId, { backfill: false }).catch(() => [])
        await this._dropPurgedTrash(projectId)
        await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
      }
      const updated = [...loaded, next].sort()
      this.trashLoadedMonths[projectId] = updated
      this.trashHasMore[projectId] = shards.some((m) => !updated.includes(m))
      return remote.length > 0
    },
    /** 多视图「按需加载某一年份」：当前年加载 year-01 至今；往年加载整年（year-01 ~ year-12）。
     *  多视图/扫描共用：切到某年时把该年份分片下载进内存并写 IDB，已加载年份直接返回已有计数不重复下载。
     *  只下载本年数据，更早年份仍按需加载，避免一次拉取全部历史 JSON 导致内存过大。 */
    async loadTrashYear(year: number): Promise<{ projects: number; tasks: number }> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return { projects: 0, tasks: 0 }
      if (this.trashLoadedYears.includes(year)) {
        const pids = Object.keys(this.trash)
        return {
          projects: pids.length,
          tasks: pids.reduce((n, pid) => n + (this.trash[pid]?.length ?? 0), 0),
        }
      }
      const client = await createOssClient(auth.creds)
      const since = `${year}-01`
      const isCurrent = year === new Date().getFullYear()
      const until = isCurrent ? monthOfNow() : `${year}-12`
      let projectCount = 0
      let taskCount = 0
      // 扫描过的项目（已有分片索引）+ 本地已加载过胶囊数据的项目
      const pids = new Set<string>([
        ...Object.keys(this.trashShardMonths ?? {}),
        ...Object.keys(this.trash ?? {}),
      ])
      for (const pid of pids) {
        if (pid === UNCATEGORIZED) continue
        let allMonths: string[] = []
        let months: string[] = []
        try {
          const known = this.trashShardMonths[pid]
          if (known?.length) {
            allMonths = known
          } else {
            allMonths = await listTrashShardMonths(client, auth.username, pid)
          }
          months = allMonths.filter((m) => m >= since && m <= until)
        } catch {
          allMonths = []
          months = []
        }
        if (!months.length) {
          // 无该年份分片（或无法枚举，如无 list 权限）：当前年份降级按「当月 + 上月」窗口加载，
          // 保证今年数据尽量完整；往年无分片视为该年无数据，跳过
          if (isCurrent) {
            await this.loadTrash(pid).catch(() => {})
            if ((this.trash[pid]?.length ?? 0) > 0) projectCount++
          }
          continue
        }
        let changed = false
        // 有界并发拉取该年各分片（Last-Modified 条件 GET，未变动的月份直接 304 复用缓存）。
        // 永久删除墓碑与分片并行拉取：必须早于下面的合并就绪，否则并集会把已永久删除的记录留在内存。
        const [results] = await Promise.all([
          mapLimit(months, TRASH_FETCH_CONCURRENCY, async (m) => {
            const remote = await fetchRemoteTrashShard(client, auth.username, pid, m)
            return { remote }
          }),
          this.fetchTombstones(pid, { backfill: false }).catch(() => []),
        ])
        for (const { remote } of results) {
          if (remote.length) {
            this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
            changed = true
            taskCount += remote.length
          }
        }
        // 合并后剔除已是「永久删除」的记录（含远端历史残留），计数同步扣减
        const dropped = await this._dropPurgedTrash(pid)
        if (dropped) {
          changed = true
          taskCount = Math.max(0, taskCount - dropped)
        }
        if (changed) await idbPut('trash', trashCacheKey(auth.username, pid), this.trash[pid])
        const loaded = new Set(this.trashLoadedMonths[pid] ?? [])
        for (const m of months) loaded.add(m)
        this.trashLoadedMonths[pid] = [...loaded].sort()
        // 保留完整分片索引并更新「加载更早」：该年份之后还有更早分片时按钮按需出现
        this.trashShardMonths[pid] = allMonths
        this.trashHasMore[pid] = allMonths.some((m) => !loaded.has(m))
        if (!this.trashLoaded.includes(pid)) this.trashLoaded.push(pid)
        if (changed) projectCount++
      }
      // 未分类：单文件整文件加载（不分片，无法只取某年）
      try {
        const remoteU = await fetchRemoteTrashShard(client, auth.username, UNCATEGORIZED)
        if (remoteU.length) {
          this.trash[UNCATEGORIZED] = mergeUnique(this.trash[UNCATEGORIZED] ?? [], remoteU)
          taskCount += remoteU.length
          await idbPut('trash', trashCacheKey(auth.username, UNCATEGORIZED), this.trash[UNCATEGORIZED])
        }
      } catch {
        /* 未分类文件不存在/网络失败：忽略 */
      }
      if (!this.trashLoaded.includes(UNCATEGORIZED)) this.trashLoaded.push(UNCATEGORIZED)
      projectCount++
      this.trashLoadedYears.push(year)
      return { projects: projectCount, tasks: taskCount }
    },
    /** 时间胶囊「按年份过滤」核心：清空其它年份的内存 + IDB 缓存（trash 数据 + etag/lm），
     *  再一次性把该年全部项目分片下载进内存（真实项目按月分片、未分类单文件按年过滤）。
     *  年份切换只经由「扫描时间胶囊文件」按钮触发；返回该年有数据的项目数与任务数。
     *  注意：不写 trashLoaded —— 导出/清空等全量路径仍依赖 trashLoaded 判断是否已加载全部年份。 */
    async switchTrashYear(year: number): Promise<{ projects: number; tasks: number }> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return { projects: 0, tasks: 0 }
      // 若尚未扫描（如首次进入页面直接加载），先枚举哪些项目存在回收站文件
      if (!Object.keys(this.trashShardMonths ?? {}).length) {
        await this.listTrashProjects().catch(() => {})
      }
      // 复制分片索引：随后要清空 trashShardMonths 重建，但需先确定该年要拉哪些分片
      const shardsByPid = { ...this.trashShardMonths }
      // 先把未落盘的胶囊变更写盘，避免清缓存丢数据
      for (const fn of trashDebouncers.values()) {
        fn.flush()
        fn.cancel()
      }
      // 清空旧年份的 IDB 缓存（trash 数据 + etag/lm），只保留即将写入的该年数据
      await idbClearTrashUserCache(auth.username)
      // 解除旧年份项目固定并清空内存态
      for (const pid of Object.keys(this.trash)) viewPins.delete(pid)
      this.trash = {}
      this.trashLoaded = []
      this.trashLoadedMonths = {}
      this.trashShardMonths = {}
      this.trashHasMore = {}
      this.trashLoadedYears = [year]
      this.trashYear = year
      const client = await createOssClient(auth.creds)
      const since = `${year}-01`
      const isCurrent = year === new Date().getFullYear()
      const until = isCurrent ? monthOfNow() : `${year}-12`
      let projectCount = 0
      let taskCount = 0
      const pids = new Set<string>([...Object.keys(shardsByPid), ...Object.keys(this.trash)])
      // 无 list 权限时无法枚举分片：降级为所有已知项目（与扫描降级策略一致）
      if (!Object.keys(shardsByPid).length) {
        const projectsStore = useProjectsStore()
        if (!projectsStore.loaded) await projectsStore.load().catch(() => {})
        for (const p of projectsStore.projects) pids.add(p.id)
      }
      // 真实项目：一次性拉取该年全部月份分片
      for (const pid of pids) {
        if (pid === UNCATEGORIZED) continue
        let allMonths: string[] = []
        let months: string[] = []
        try {
          const known = shardsByPid[pid]
          if (known?.length) {
            allMonths = known
          } else {
            allMonths = await listTrashShardMonths(client, auth.username, pid)
          }
          months = allMonths.filter((m) => m >= since && m <= until)
        } catch {
          allMonths = []
          months = []
        }
        if (!months.length) {
          // 无该年份分片（或无法枚举）：当前年份降级按「当月 + 上月」窗口加载，保证今年数据尽量完整
          if (isCurrent) {
            try {
              await migrateLegacyTrash(client, auth.username, pid)
              const remote = await fetchRemoteTrash(client, auth.username, pid)
              if (remote.length) {
                this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
                taskCount += remote.length
                projectCount++
                viewPins.add(pid)
                await idbPut('trash', trashCacheKey(auth.username, pid), this.trash[pid])
              }
            } catch {
              /* 单项目失败不影响其它项目 */
            }
          }
          continue
        }
        // 有界并发拉取该年各分片（Last-Modified 条件 GET，未变动的月份 304 复用缓存）；
        // 先收集结果再串行合并，避免并发写共享 trash[pid] 数组。
        // 永久删除墓碑并行拉取：必须早于合并就绪，否则并集会把已永久删除的记录留在内存。
        const [results] = await Promise.all([
          mapLimit(months, TRASH_FETCH_CONCURRENCY, async (m) => {
            const remote = await fetchRemoteTrashShard(client, auth.username, pid, m)
            return { m, remote }
          }),
          this.fetchTombstones(pid, { backfill: false }).catch(() => []),
        ])
        let changed = false
        for (const { remote } of results) {
          if (remote.length) {
            this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
            changed = true
            taskCount += remote.length
          }
        }
        // 合并后剔除已是「永久删除」的记录（含远端历史残留），计数同步扣减
        const dropped = await this._dropPurgedTrash(pid)
        if (dropped) {
          changed = true
          taskCount = Math.max(0, taskCount - dropped)
        }
        if (changed) {
          await idbPut('trash', trashCacheKey(auth.username, pid), this.trash[pid])
          projectCount++
          viewPins.add(pid)
        }
        this.trashLoadedMonths[pid] = [...new Set([...(this.trashLoadedMonths[pid] ?? []), ...months])].sort()
        // 保留完整分片索引（导出/清空据此判断还有更早分片可加载）
        this.trashShardMonths[pid] = allMonths
        this.trashHasMore[pid] = allMonths.some((m) => !(this.trashLoadedMonths[pid] ?? []).includes(m))
      }
      // 未分类：单文件整文件拉取，按年份过滤后只保留该年任务
      try {
        const remoteU = await fetchRemoteTrashShard(client, auth.username, UNCATEGORIZED)
        if (remoteU.length) {
          const yearStr = String(year)
          const filtered = remoteU.filter((t) => dateKeyOf(t.updatedAt || '').slice(0, 4) === yearStr)
          if (filtered.length) {
            this.trash[UNCATEGORIZED] = mergeUnique(this.trash[UNCATEGORIZED] ?? [], filtered)
            taskCount += filtered.length
            projectCount++
            viewPins.add(UNCATEGORIZED)
            await idbPut('trash', trashCacheKey(auth.username, UNCATEGORIZED), this.trash[UNCATEGORIZED])
          }
        }
      } catch {
        /* 未分类文件不存在/网络失败：忽略 */
      }
      return { projects: projectCount, tasks: taskCount }
    },
    /** 「扫描时间胶囊文件」按钮：直接全量加载全部项目全部月份分片并合并进内存（不再弹确认框），
     *  更早年份一并加载，展开后无需再按需下载；未点击扫描按钮时多视图仍按需动态加载。 */
    async loadTrashAll(): Promise<{ projects: number; tasks: number }> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return { projects: 0, tasks: 0 }
      const client = await createOssClient(auth.creds)
      let projectCount = 0
      let taskCount = 0
      // 扫描过的项目（已有分片索引）+ 本地已加载过胶囊数据的项目
      const pids = new Set<string>([
        ...Object.keys(this.trashShardMonths ?? {}),
        ...Object.keys(this.trash ?? {}),
      ])
      const loadedYears = new Set<number>(this.trashLoadedYears)
      for (const pid of pids) {
        if (pid === UNCATEGORIZED) continue
        let allMonths: string[] = []
        try {
          const known = this.trashShardMonths[pid]
          if (known?.length) {
            allMonths = known
          } else {
            allMonths = await listTrashShardMonths(client, auth.username, pid)
          }
        } catch {
          allMonths = []
        }
        if (!allMonths.length) {
          // 无分片索引（或无法枚举，如无 list 权限）：降级整文件加载
          await this.loadTrash(pid).catch(() => {})
          if ((this.trash[pid]?.length ?? 0) > 0) projectCount++
          for (const m of this.trashLoadedMonths[pid] ?? []) loadedYears.add(Number(m.slice(0, 4)))
          continue
        }
        let changed = false
        // 有界并发拉取该项目全部分片（Last-Modified 条件 GET，未变动的月份直接 304 复用缓存）。
        // 永久删除墓碑并行拉取：必须早于合并就绪，否则并集会把已永久删除的记录留在内存。
        const [results] = await Promise.all([
          mapLimit(allMonths, TRASH_FETCH_CONCURRENCY, async (m) => {
            const remote = await fetchRemoteTrashShard(client, auth.username, pid, m)
            return { m, remote }
          }),
          this.fetchTombstones(pid, { backfill: false }).catch(() => []),
        ])
        for (const { m, remote } of results) {
          if (remote.length) {
            this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
            changed = true
            taskCount += remote.length
          }
          loadedYears.add(Number(m.slice(0, 4)))
        }
        // 合并后剔除已是「永久删除」的记录（含远端历史残留），计数同步扣减
        const dropped = await this._dropPurgedTrash(pid)
        if (dropped) {
          changed = true
          taskCount = Math.max(0, taskCount - dropped)
        }
        if (changed) await idbPut('trash', trashCacheKey(auth.username, pid), this.trash[pid])
        const loaded = new Set(this.trashLoadedMonths[pid] ?? [])
        for (const m of allMonths) loaded.add(m)
        this.trashLoadedMonths[pid] = [...loaded].sort()
        // 保留完整分片索引并置「加载更早」为否：全部月份已加载完毕
        this.trashShardMonths[pid] = allMonths
        this.trashHasMore[pid] = false
        if (!this.trashLoaded.includes(pid)) this.trashLoaded.push(pid)
        if (changed) projectCount++
      }
      // 未分类：单文件整文件加载（不分片，无法只取某年）
      try {
        const remoteU = await fetchRemoteTrashShard(client, auth.username, UNCATEGORIZED)
        if (remoteU.length) {
          this.trash[UNCATEGORIZED] = mergeUnique(this.trash[UNCATEGORIZED] ?? [], remoteU)
          taskCount += remoteU.length
          await idbPut('trash', trashCacheKey(auth.username, UNCATEGORIZED), this.trash[UNCATEGORIZED])
        }
      } catch {
        /* 未分类文件不存在/网络失败：忽略 */
      }
      if (!this.trashLoaded.includes(UNCATEGORIZED)) this.trashLoaded.push(UNCATEGORIZED)
      projectCount++
      // 全部月份已加载：年份按需加载的缓存标记直接补齐，多视图切年不再重复下载
      this.trashLoadedYears = [...loadedYears].sort((a, b) => a - b)
      return { projects: projectCount, tasks: taskCount }
    },
    /** 退出时间胶囊页：释放时间胶囊占用的内存并清空该用户全部 IDB 缓存（trash 数据 + etag/lm）。
     *  下次进入重新从 OSS 下载当前年份数据，避免本地残留其它年份/旧数据占存储配额。 */
    async releaseTrashMemory() {
      // 先把未落盘的胶囊变更写盘，再清内存，避免丢数据
      for (const fn of trashDebouncers.values()) {
        fn.flush()
        fn.cancel()
      }
      // 解除全部胶囊项目固定，交回 LRU 逐出（仅胶囊页挂载期间 pin 的是胶囊项目）
      for (const pid of Object.keys(this.trash)) viewPins.delete(pid)
      capsulePins.clear()
      this.trash = {}
      this.trashLoaded = []
      this.trashLoadedMonths = {}
      this.trashShardMonths = {}
      this.trashHasMore = {}
      this.trashLoadedYears = []
      this.trashYear = null
      const auth = useAuthStore()
      if (auth.username) await idbClearTrashUserCache(auth.username)
    },
    /** 彻底删除某项目全部回收站文件（分片 + 旧版 trash.json / 未分类 today_trash.json），
     *  并清空内存与 IDB 缓存。用于「清空回收站」与整项目恢复，删除后该项目不再出现在回收站扫描结果中。 */
    async purgeTrashFiles(projectId: string): Promise<void> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = await createOssClient(auth.creds)
      if (projectId === UNCATEGORIZED) {
        await client.delete(paths.todayTrash(auth.username)).catch(() => {})
      } else {
        let months: string[] = []
        try {
          months = await listTrashShardMonths(client, auth.username, projectId)
        } catch {
          // 枚举失败时兜底删除已加载月份，尽力而为
          months = [...(this.trashLoadedMonths[projectId] ?? [])]
        }
        for (const m of months) {
          await client.delete(trashFilePath(auth.username, projectId, m)).catch(() => {})
          await idbDel('trash', trashCacheKey(auth.username, projectId, m))
          await idbDel('kv', `etag:${auth.username}:${projectId}:trash:${m}`)
          await idbDel('kv', lmKeyOf(`etag:${auth.username}:${projectId}:trash:${m}`))
        }
        await client.delete(paths.trash(auth.username, projectId)).catch(() => {})
      }
      this.trash[projectId] = []
      await idbDel('trash', trashCacheKey(auth.username, projectId))
      this.trashLoadedMonths[projectId] = []
      this.trashShardMonths[projectId] = []
      this.trashHasMore[projectId] = false
    },
    /** 回收站扫描：仅枚举哪些项目存在回收站文件（不下载任何文件内容），
     *  展开某个项目时再按需 loadTrash 打开对应文件，避免一次性拉取全部数据包。
     *  listed=false 表示无 list 权限，调用方应降级为已知项目。 */
    async listTrashProjects(): Promise<{
      ids: string[]
      /** 各项目回收站文件（trash.json / today_trash.json）最新变动时间（ISO），用于按“最新回收时间”倒序 */
      latestByProject: Record<string, string>
      hasUncategorized: boolean
      listed: boolean
    }> {
      const auth = useAuthStore()
      const ids = new Set<string>()
      const latestByProject: Record<string, string> = {}
      let hasUncategorized = false
      let listed = true
      // 每次全量扫描重建分片月份索引，避免上一次扫描的残留
      this.trashShardMonths = {}
      if (auth.creds && auth.username) {
        try {
          const client = await createOssClient(auth.creds)
          // OSS 单次最多返回 1000 个对象；随任务/附件增多列表可能被截断，
          // 只读第一页会漏掉后面的回收站项目，因此用 marker 翻页拉全量。
          let marker: string | undefined
          do {
            const query: Record<string, string | number> = {
              prefix: `users/${auth.username}/`,
              'max-keys': 1000,
            }
            if (marker) query.marker = marker
            const res = await client.list(query as never, {} as never)
            for (const obj of res.objects ?? []) {
              const name = obj.name
              if (name.endsWith('/trash.json')) {
                const seg = name.split('/')
                const pid = seg[seg.length - 2]
                ids.add(pid)
                if (obj.lastModified) latestByProject[pid] = String(obj.lastModified)
              } else if (name.endsWith('/today_trash.json')) {
                hasUncategorized = true
                if (obj.lastModified) latestByProject[UNCATEGORIZED] = String(obj.lastModified)
              } else {
                // 按月分片：trash/{YYYY-MM}.json
                const m = /\/trash\/(\d{4}-\d{2})\.json$/.exec(name)
                if (m) {
                  const seg = name.split('/')
                  const pid = seg[seg.length - 3]
                  ids.add(pid)
                  const month = m[1]
                  if (obj.lastModified && (!latestByProject[pid] || String(obj.lastModified) > latestByProject[pid])) {
                    latestByProject[pid] = String(obj.lastModified)
                  }
                  this.trashShardMonths[pid] = [...new Set([...(this.trashShardMonths[pid] ?? []), month])].sort()
                }
              }
            }
            marker = res.isTruncated && res.nextMarker ? res.nextMarker : undefined
          } while (marker)
        } catch {
          listed = false
          /* 无 list 权限等场景：调用方降级为已知项目 */
        }
      }
      return { ids: [...ids], latestByProject, hasUncategorized, listed }
    },
    /** 拉取单个项目：从 OSS 重拉任务并与本地按 updatedAt 合并（含回收站/墓碑），
     *  有本地改动（含尚未落盘的防抖修改）时写回合并结果，CAS 兜底冲突。
     *  供轮询增量同步与 syncAll 复用；远端文件不存在时静默保留本地数据。
     *  force=true：跳过 If-Modified-Since 条件 GET（强制 200 重拉），用于追平后的
     *  「被门闩延迟的写回重跑 / 上次会话未落盘保存的重放」。 */
    async syncProject(projectId: string, force = false) {
      if (projectId === UNCATEGORIZED) return
      this.touchProject(projectId)
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = await createOssClient(auth.creds)
      const key = tasksFilePath(auth.username, projectId)
      // 条件 GET：带本地 Last-Modified（If-Modified-Since，OSS 不认 If-None-Match），远端未变化返回 304
      const etagKey = `etag:${auth.username}:${projectId}`
      const lmKey = lmKeyOf(etagKey)
      const lm = await idbGet<string>('kv', lmKey)
      const res = await client.get(
        key,
        !force && lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
      )
      if (res.res.status === 304) return // 远端未变化（Last-Modified 命中），无需下载/合并
      const remote = JSON.parse(res.content.toString()) as Task[]
      normalizeTasks(remote)
      const { active: rawRemoteActive, deleted: remoteDeleted } = splitDeleted(remote)
      // 丢弃任务文件里 projectId 与所在项目不一致的过期副本（跨项目移动残留），
      // 并跨项目去重（其它已加载项目里有更新的同 id 副本时本份视为过期），
      // 防止轮询合并把已移走的任务“复活”回源项目（BUG：移动任务被复制一份）
      const remoteActive = await filterStaleAcrossProjectsAsync(
        this.tasks,
        projectId,
        filterTasksForProject(rawRemoteActive, projectId),
        auth.username,
      )
      const local = await filterStaleAcrossProjectsAsync(
        this.tasks,
        projectId,
        filterTasksForProject(this.tasks[projectId] ?? [], projectId),
        auth.username,
      )
      // 墓碑来源 = 本地日志 + 远端日志（缺失回填/失败降级回收站近窗分片）+ 任务文件内 deleted 残留。
      // 日常同步不再下载当月/上月回收站分片（时间胶囊数据由时间胶囊页按需加载）。
      const tombstones = await this.collectTombstones(projectId, remoteDeleted)
      let merged = sortActiveList(
        applyDeletedTombstones(mergeTasks(local, remoteActive), tombstones),
      )
      // 自愈去重：同链重复日 / 同链多 pending 收敛为一条（异常时写回收站 / repeats 落盘），
      // 让「手机端陈旧缓存恢复/物化出的第二条重复任务」在同步合并时被清理并写回 OSS
      merged = sortActiveList(await this._selfHealRepeatDuplicates(projectId, merged))
      // 自愈孤儿副本：跨项目转成子任务后源项目残留的顶层旧副本（同 id 已作为某任务子任务）
      merged = sortActiveList(await this._selfHealOrphanSubtasks(projectId, merged))
      // 防复活二次确认：merged 里「本地独有、远端活跃文件没有」的任务，若在远端回收站近窗分片
      // （当月+上月）存在删除/归档记录（墓碑缺失时的兜底证据），则一并剔除——既不入本地视图、
      // 也不写回 OSS，否则本端陈旧缓存会把别端已存入时间胶囊/已删除的任务并集写回复活
      // （与墓碑写盘失败组合，正是「任务消失后又出现、两端数据不一致、重启复活」的放大路径）。
      // 日常同步不读回收站分片以省流量，这里仅在「合并结果含本地独有任务」（低频，且下方写回
      // 受 allowWriteBack 限流）时补查近窗两月，成本可控；拉取失败不阻塞（墓碑日志主路径兜底）。
      const remoteById = new Map<string, Task>(rawRemoteActive.map((t) => [t.id, t]))
      const localOnly = merged.filter((t) => !remoteById.has(t.id))
      if (localOnly.length) {
        try {
          const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
          if (remoteTrash.length) {
            const trashTombstones = mergeDeletedTombstones([], remoteTrash, [])
            merged = sortActiveList(applyDeletedTombstones(merged, trashTombstones))
          }
        } catch {
          /* 拉取失败不阻塞：墓碑日志主路径仍在兜底 */
        }
      }
      this.tasks[projectId] = merged
      await idbPut('tasks', taskCacheKey(auth.username, projectId), merged)
      // 任务文件内残留的 deleted 墓碑（遗留数据迁移）并入本地回收站；展示数据不再由日常同步预载
      const oldTrash = this.trash[projectId] ?? []
      const mergedTrash = mergeUnique(oldTrash, remoteDeleted)
      if (JSON.stringify(oldTrash) !== JSON.stringify(mergedTrash)) {
        this.trash[projectId] = mergedTrash
        await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
        void this._persistTrash(projectId, true)
      }
      const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
      if (newEtag) await idbPut('kv', etagKey, newEtag)
      const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
      if (newLm) await idbPut('kv', lmKey, newLm)
      // 合并结果相对远端内容有差异时写回。**但只有本端确实"新增或替换"了内容才写回**：
      // 即 merged 里存在远端没有的 id（本地独有任务），或同 id 的内容与远端不同
      // （本地改动尚未上云 / 平局裁决出的胜者）。仅"远端有条目被本端过滤掉"（跨项目
      // 过期副本过滤、墓碑剔除）不触发写回——否则会出现一端删、一端并集保留的
      // 两端互写死循环（每 2 秒一次 PUT）。
      // 配合 canonicalJson 的 undefined 归一 + mergeTasks 平局确定性裁决：
      // 内容其实一致（含显式 undefined 键）不再误判为差异，真正分歧最多回写一次即收敛。
      const localAddsOrReplaces = merged.some((t) => {
        const r = remoteById.get(t.id)
        return !r || canonicalJson(t) !== canonicalJson(r)
      })
      if (
        localAddsOrReplaces &&
        canonicalJson(merged) !== canonicalJson(sortActiveList([...rawRemoteActive]))
      ) {
        if (this.syncCatchingUp) {
          // F1：追平门闩——合并写回延迟到追平后 force 重跑（追平期间本地数据可能陈旧，
          // 写回会让陈旧本地内容在合并裁决中抢占先机、覆盖他端更新；追平后数据可信，
          // 再由 finalizeSyncCatchUp 按原条件重跑写回）。不消耗 allowWriteBack 限流窗口。
          this.deferWriteback(projectId)
        } else if (allowWriteBack(projectId)) {
          await this.saveProject(projectId, [...merged])
        }
      }
    },
    /** 手动/下拉刷新全量同步：逐项目调用 syncProject，返回失败的项目数。 */
    async syncAll(projectIds: string[]) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return projectIds.length
      let failed = 0
      for (const projectId of projectIds) {
        try {
          await this.syncProject(projectId)
        } catch (e) {
          const err = e as { code?: string | number; status?: number }
          if (err.code === 'NoSuchKey' || err.status === 404 || err.code === 'NoSuchBucket') {
            // 远端文件不存在：保留本地数据，不视为错误
            continue
          }
          failed++
        }
      }
      // 同步合并后统一跨天归档：昨日完成的已完成任务移入回收站
      await this.sweepCompleted()
      // 重复模板：刷新同步时同样执行到期物化
      await this.materializeRepeats()
      this.loadedProjects = [...new Set([...this.loadedProjects, ...projectIds])]
      return failed
    },
    async sweepCompleted(projectId?: string) {
      // F1：追平门闩——加载/同步期间本地 updatedAt 可能陈旧（他端已完成/已恢复任务的旧状态），
      // 此时归档会把「他端已恢复/编辑过」的任务误移入回收站并写墓碑（跨端消失）。追平后由
      // finalizeSyncCatchUp 在数据可信时统一执行。离线会话（永不追平）则暂停归档：
      // 已完成任务仍显示在列表中（状态 completed），联网追平后自动归档。
      if (this.syncCatchingUp) return
      const auth = useAuthStore()
      const today = todayKey()
      const pids = projectId ? [projectId] : Object.keys(this.tasks)
      for (const pid of pids) {
        const list = this.tasks[pid] ?? []
        const stale = list.filter(
          (t) => t.status === 'completed' && dateKeyOf(t.updatedAt) < today,
        )
        if (!stale.length) continue
        this.tasks[pid] = list.filter((t) => !stale.includes(t))
        this.trash[pid] = mergeUnique(this.trash[pid] ?? [], stale)
        await idbPut('tasks', taskCacheKey(auth.username, pid), this.tasks[pid])
        await idbPut('trash', trashCacheKey(auth.username, pid), this.trash[pid])
        // 墓碑先落：立即写盘墓碑日志，再写 trash/tasks，严格满足「墓碑→trash→tasks」写顺序
        await this.upsertTombstones(pid, stale)
        await this.saveTombstonesNow(pid)
        void this._persistTrash(pid, true)
        this._persist(pid)
        logAudit('自动归档昨日完成任务', safeDetail(`项目ID：${pid}，共 ${stale.length} 项`))
      }
    },
    async saveProject(projectId: string, snapshot?: Task[]): Promise<boolean> {
      if (projectId === UNCATEGORIZED) return false
      savingNow.add(projectId)
      try {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      // 使用快照，避免登出/重置竞态下读到被清空的 store
      let list = (snapshot ?? this.tasks[projectId] ?? []).slice()
      // 写回前跨项目去重：丢弃本项目内存里已被移到其它项目（其它项目缓存有更新副本）的
      // 过期任务，防止把已移走的任务旧副本写回源项目（BUG：移动任务被复制一份）。
      // 仅对非快照的常规保存生效：快照（回滚/同步写回）是上游已过滤的结果，不应再次裁剪。
      if (!snapshot) {
        const filteredList = await filterStaleAcrossProjectsAsync(
          this.tasks,
          projectId,
          filterTasksForProject(list, projectId),
          auth.username,
        )
        if (filteredList.length !== list.length) {
          list = filteredList
          this.tasks[projectId] = filteredList
        }
      }
      const key = tasksFilePath(auth.username, projectId)
      const etagKey = `etag:${auth.username}:${projectId}`
      let knownEtag = await idbGet<string>('kv', etagKey)
      try {
      // CAS 写入 + 冲突合并：最多重试 3 次，防止多端同时编辑互相覆盖（丢失更新）
      // 冲突合并是否真的引入了远端新数据：仅用于决定是否弹「已自动合并」提示，
      // 只是版本号过期、内容一致时静默完成，避免多端同时在线时反复误报刷屏
      let mergedNewData = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<Task[]>(client, key, list, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
          await idbDel('kv', lmKeyOf(etagKey))
          await idbPut('tasks', taskCacheKey(auth.username, projectId), list)
            queueSyncChange(auth.username, 'tasks', projectId)
          if (attempt > 0 && mergedNewData) useUiStore().toast('检测到其他设备同时修改，已自动合并最新数据', 'ok')
          // F3 写前队列：任务已成功落盘 → 清除脏标记
          this.clearDirtyPid(projectId)
          return true
        }
        // 冲突：把远端与本地按 updatedAt 合并后再重试，不丢失任一端修改
        if (result.remote) {
          const remoteList = [...(result.remote as Task[])]
          normalizeTasks(remoteList)
          const { active: remoteActive, deleted: remoteDeleted } = splitDeleted(remoteList)
          // 冲突合并同样丢弃源项目文件里 projectId 不一致/其它已加载项目有更新副本的
          // 过期任务，避免复活已移走任务（BUG：移动任务被复制一份）
          const filteredRemote = await filterStaleAcrossProjectsAsync(
            this.tasks,
            projectId,
            filterTasksForProject(remoteActive, projectId),
            auth.username,
          )
          // 墓碑来源与 syncProject 一致：本地日志 + 远端日志（回填/降级）+ 文件内 deleted 残留
          const tombstones = await this.collectTombstones(projectId, remoteDeleted)
          // 对比“本次原本要写的内容”：仅当合并结果有实质差异（远端确实带入新数据/删除墓碑影响结果）
          // 才标记为真合并；否则只是版本号过期、内容一致，不弹「已自动合并」提示
          const beforeMerge = list
          list = sortActiveList(applyDeletedTombstones(mergeTasks(list, filteredRemote), tombstones))
          // 自愈孤儿副本：跨项目转成子任务后源项目残留的顶层旧副本，CAS 冲突合并时一并清理
          list = sortActiveList(await this._selfHealOrphanSubtasks(projectId, list))
          if (canonicalJson(list) !== canonicalJson(sortActiveList([...beforeMerge]))) {
            mergedNewData = true
          }
          knownEtag = result.remoteEtag ?? undefined
          if (!snapshot) {
            this.tasks[projectId] = list
            await idbPut('tasks', taskCacheKey(auth.username, projectId), list)
            // 任务文件内残留的 deleted 墓碑（遗留数据迁移）并入本地回收站；不再拉回收站分片
            const oldTrash = this.trash[projectId] ?? []
            const mergedTrash = mergeUnique(oldTrash, remoteDeleted)
            if (JSON.stringify(oldTrash) !== JSON.stringify(mergedTrash)) {
              this.trash[projectId] = mergedTrash
              await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
              void this._persistTrash(projectId, true)
            }
          }
        } else {
          // 远端为空但发生创建竞态：重拉远端内容后再试
          knownEtag = undefined
        }
      }
      useUiStore().toast('保存失败：检测到其他设备持续修改，请稍后重试', 'error')
      return false
      } catch (e) {
        console.error('保存任务到 OSS 失败', e)
        useUiStore().toast(`保存失败：${describeOssError(e)}`, 'error')
        return false
      }
      } finally {
        savingNow.delete(projectId)
      }
    },
    /** 写单个回收站文件（真实项目某月分片 / 未分类单文件）：CAS 条件写入 + 冲突合并。
     *  返回 { ok, merged }：merged 为冲突合并后实际写入（或即将写入）的任务列表。
     *  过滤：已写入「永久删除墓碑」（purged:<id>）的记录既不参与并集合并、也不写盘，
     *  否则本端陈旧内存/缓存会把别端已永久删除的记录并回复活。 */
    async _saveTrashShard(
      client: OssClient,
      username: string,
      projectId: string,
      month: string | undefined,
      list: Task[],
    ): Promise<{ ok: boolean; merged: Task[]; gone?: boolean }> {
      // 纵深防御：空用户名绝不写盘，否则会生成 users//projects/... 的空用户名键
      if (!username) return { ok: false, merged: list }
      const key = trashFilePath(username, projectId, month)
      const etagKey = `etag:${username}:${projectId}:trash${month ? `:${month}` : ''}`
      const cacheKey = trashCacheKey(username, projectId, month)
      // 本端内存已知的永久删除墓碑：写前直接剔除（无网络请求）
      const purgedLocal = purgedTaskIds(this.tombstonesOf(projectId))
      if (purgedLocal.size) list = list.filter((t) => !purgedLocal.has(t.id))
      let knownEtag = await idbGet<string>('kv', etagKey)
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<Task[]>(client, key, list, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
          await idbDel('kv', lmKeyOf(etagKey))
          await idbPut('trash', cacheKey, list)
          return { ok: true, merged: list }
        }
        if (result.reason === 'remote-gone') {
          // R3 修复：本端同步过该分片（knownEtag 存在）而远端分片已被删除
          // （如另一台设备清空时间胶囊）。本地缓存作废，绝不当作新建写回——
          // 否则已清空的数据会被缓存复活。返回 gone 由 saveTrash 跳过后续处理。
          if (month) {
            const goneIds = new Set(list.map((t) => t.id))
            this.trash[projectId] = (this.trash[projectId] ?? []).filter((t) => !goneIds.has(t.id))
            this.trashLoadedMonths[projectId] = (this.trashLoadedMonths[projectId] ?? []).filter((m) => m !== month)
            this.trashShardMonths[projectId] = (this.trashShardMonths[projectId] ?? []).filter((m) => m !== month)
          } else {
            this.trash[projectId] = []
          }
          await idbDel('trash', cacheKey)
          await idbDel('kv', etagKey)
          await idbDel('kv', lmKeyOf(etagKey))
          return { ok: true, merged: [], gone: true }
        }
        if (result.remote) {
          // 冲突合并前把「永久删除墓碑」拉到最新（条件 GET / 304 零下载，一次写盘最多一次）：
          // 本端缓存可能比别端的删除动作旧，只靠内存墓碑会漏掉刚被永久删除的记录。
          const purged = purgedTaskIds(await this.fetchTombstones(projectId, { backfill: false }).catch(() => []))
          if (purged.size) {
            list = list.filter((t) => !purged.has(t.id))
            await this._dropPurgedTrash(projectId)
          }
          const remoteList = [...(result.remote as Task[])]
          normalizeTasks(remoteList)
          list = mergeTasks(list, remoteList)
          if (purged.size) list = list.filter((t) => !purged.has(t.id))
          knownEtag = result.remoteEtag ?? undefined
        } else {
          knownEtag = undefined
        }
      }
      return { ok: false, merged: list }
    },
    async saveTrash(projectId: string, snapshot?: Task[]): Promise<boolean> {
      savingNow.add(projectId)
      try {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      // 永久删除墓碑（防并集复活）：本端还没加载过该项目墓碑时先取一次（条件 GET / 304 零下载），
      // 再剔除内存里已被他端永久删除的记录。否则下面的并集合并会把它们写回 OSS 分片。
      // 读失败一律降级（不发散错误）：saveTrash 不应因为墓碑读不到而整体失败。
      if (!this.tombstonesReady(projectId)) {
        await this.fetchTombstones(projectId, { backfill: false }).catch(() => [])
      }
      await this._dropPurgedTrash(projectId)
      const purged = purgedTaskIds(this.tombstonesOf(projectId))
      let list = (snapshot ?? this.trash[projectId] ?? []).filter((t) => !purged.has(t.id)).slice()
      // 未分类回收站：单文件直写（不分片）
      if (projectId === UNCATEGORIZED) {
        const r = await this._saveTrashShard(client, auth.username, projectId, undefined, list)
        if (r.gone) {
          // 远端文件已被清空/重置：内存与 IDB 已在 _saveTrashShard 内作废，直接返回
          return true
        }
        if (!r.ok) {
          useUiStore().toast('保存时间胶囊失败：检测到其他设备持续修改，请稍后重试', 'error')
          return false
        }
        await idbPut('trash', trashCacheKey(auth.username, projectId), r.merged)
        queueSyncChange(auth.username, 'trash', projectId)
        // F3 写前队列：回收站已成功落盘 → 清除脏标记
        this.clearDirtyPid(projectId)
        return true
      }
      // 真实项目：按月分片写入，只碰「内存中已有任务的月份 + 已加载窗口」，
      // 未加载的旧分片不读不写，避免回收站历史增长拖慢日常保存。
      const byMonth = groupTrashByMonth(list)
      const loadedSet = new Set(this.trashLoadedMonths[projectId] ?? [])
      // 内存里出现未加载月份（跨月新删除 / 导入旧记录等）：先拉远端该月分片合并，
      // 避免只写内存里的几条而覆盖掉只存在于远端的同月数据。
      for (const m of byMonth.keys()) {
        if (loadedSet.has(m)) continue
        try {
          const remote = await fetchRemoteTrashShard(client, auth.username, projectId, m)
          if (remote.length) {
            // 时感知合并（与 CAS 冲突合并 mergeTasks 同一语义）：updatedAt 更新者胜、平局本地（内存）胜。
            // 修复导入备份到未加载月份时，mergeUnique(remote, memory) 让远端旧数据盲目覆盖备份新数据、
            // 且内存与 OSS 分叉的问题（备份更新→恢复备份；云端更新→不降级云端）。
            const merged = mergeTasks(byMonth.get(m) ?? [], remote)
            byMonth.set(m, merged)
            this.trash[projectId] = mergeTasks(this.trash[projectId] ?? [], merged)
          }
        } catch {
          /* 拉取失败按内存内容写（该月未加载，属边缘场景，不阻塞保存） */
        }
        loadedSet.add(m)
      }
      this.trashLoadedMonths[projectId] = [...loadedSet].sort()
      // 需要处理的月份 = 内存含有的月份 ∪ 已加载窗口（已加载但变空 => 删除分片文件）
      const months = new Set<string>([...byMonth.keys(), ...loadedSet])
      let ok = true
      for (const m of [...months].sort()) {
        const tasks = byMonth.get(m) ?? []
        if (tasks.length) {
          const r = await this._saveTrashShard(client, auth.username, projectId, m, tasks)
          // 远端分片已被清空/重置：内存/IDB 已在 _saveTrashShard 内作废，跳过该月
          if (r.gone) continue
          ok = ok && r.ok
          // 冲突合并带回远端数据：同步进内存，保证 IDB 合并缓存与 UI 一致
          if (r.ok && r.merged.length !== tasks.length) {
            this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], r.merged)
          }
        } else {
          // 已加载月份清空：删除分片文件（忽略 404），项目名随之从回收站扫描结果消失
          await client.delete(trashFilePath(auth.username, projectId, m)).catch(() => {})
          await idbDel('trash', trashCacheKey(auth.username, projectId, m))
          await idbDel('kv', `etag:${auth.username}:${projectId}:trash:${m}`)
        }
      }
      if (!ok) {
        useUiStore().toast('保存时间胶囊失败：检测到其他设备持续修改，请稍后重试', 'error')
        return false
      }
      // 更新合并 IDB 缓存（UI / 下次 loadTrash 直接读取）
      await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId] ?? list)
      queueSyncChange(auth.username, 'trash', projectId)
      // F3 写前队列：回收站已成功落盘 → 清除脏标记
      this.clearDirtyPid(projectId)
      return true
      } catch (e) {
        console.error('保存时间胶囊到 OSS 失败', e)
        useUiStore().toast(`保存时间胶囊失败：${describeOssError(e)}`, 'error')
        return false
      }
      finally {
        savingNow.delete(projectId)
      }
    },
    _persist(projectId: string) {
      const auth = useAuthStore()
      void idbPut('tasks', taskCacheKey(auth.username, projectId), this.tasks[projectId] ?? [])
      ensureDebouncer(this, projectId)()
      this._syncReminders()
      // F3 写前队列：标记「有排期未落盘的变更」，页面被杀时由下次启动重放
      this.markDirtyPid(projectId)
    },
    /** 回收站变更持久化（immediate=true 时跳过防抖立即保存） */
    _persistTrash(projectId: string, immediate = false) {
      const auth = useAuthStore()
      void idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId] ?? [])
      const fn = ensureTrashDebouncer(this, projectId)
      if (immediate) {
        void this.saveTrashNow(projectId)
      } else {
        fn()
      }
      // F3 写前队列
      this.markDirtyPid(projectId)
    },
    /* ---- 时间胶囊墓碑日志：写入 / 移除 / 落盘 / 读取 ---- */
    /** 合并视图：内存中全部分片桶（只可能是 上月/当月/下月）+ purged 长库。
     *  这就是旧版那个「单数组」的等价物——下游（applyDeletedTombstones / purgedTaskIds /
     *  mergeTombstoneTasks）全部沿用同一形态，语义层零改动。 */
    tombstonesOf(projectId: string): TombstoneEntry[] {
      const shards = this.tombstoneShards[projectId] ?? {}
      const out: TombstoneEntry[] = []
      for (const list of Object.values(shards)) out.push(...list)
      out.push(...(this.tombstonePurged[projectId] ?? []))
      return dedupeTombstones(out)
    },
    /** 是否已从远端（或 IDB 缓存）加载过该项目的墓碑。
     *  必须独立标记：三桶为空 ≠ 未加载（否则 clearPurgedTombstones 会跳过读盘，
     *  清不掉 OSS 上仍存在的 purged 证据 → 恢复永久删除任务后又被剔掉）。 */
    tombstonesReady(projectId: string): boolean {
      return this.tombstonesLoaded.includes(projectId)
    },
    /** 内存里是否有任何墓碑数据（已落盘 or 待落盘）。
     *  与 tombstonesReady 的区别：追平门闩期间的自愈路径只写内存（upsertTombstonesLocalOnly），
     *  此时 ready 仍为 false 但数据必须被 flush —— 用 ready 判断会漏掉这次写回。 */
    hasTombstoneData(projectId: string): boolean {
      if (this.tombstonesReady(projectId)) return true
      const shards = this.tombstoneShards[projectId]
      if (shards && Object.values(shards).some((l) => l.length)) return true
      return (this.tombstonePurged[projectId] ?? []).length > 0
    },
    /** 墓碑三桶快照（供回滚还原）：深拷贝，避免回滚期间被并发写改动 */
    snapshotTombstones(projectId: string): TombstoneSnapshot {
      const shards: Record<string, TombstoneEntry[]> = {}
      for (const [m, list] of Object.entries(this.tombstoneShards[projectId] ?? {})) {
        shards[m] = [...list]
      }
      return {
        shards,
        purged: [...(this.tombstonePurged[projectId] ?? [])],
        loaded: this.tombstonesReady(projectId),
      }
    },
    /** 把墓碑三桶还原为快照（内存 + IDB），不清 OSS（OSS 由调用方决定是否写回） */
    async restoreTombstones(projectId: string, snap: TombstoneSnapshot): Promise<void> {
      this.tombstoneShards[projectId] = snap.shards
      this.tombstonePurged[projectId] = snap.purged
      this.setTombstonesReady(projectId, snap.loaded)
      await this._persistTombstonesLocal(projectId, Object.keys(snap.shards))
    },
    /** 标记「已加载」（或还原为未加载）*/
    setTombstonesReady(projectId: string, ready: boolean): void {
      const has = this.tombstonesLoaded.includes(projectId)
      if (ready && !has) this.tombstonesLoaded = [...this.tombstonesLoaded, projectId]
      if (!ready && has) this.tombstonesLoaded = this.tombstonesLoaded.filter((p) => p !== projectId)
    },
    /** 把三桶写进 IDB 缓存（内存 -> IDB，不碰 OSS）。
     *  months 限定要写的分片（默认写内存里全部）；传空数组则只写 purged 长库。 */
    async _persistTombstonesLocal(projectId: string, months?: string[]): Promise<void> {
      const auth = useAuthStore()
      if (!auth.username) return
      const shards = this.tombstoneShards[projectId] ?? {}
      const list = months ?? Object.keys(shards)
      for (const m of list) {
        await idbPut('kv', tombstoneShardCacheKey(auth.username, projectId, m), shards[m] ?? [])
      }
      await idbPut('kv', tombstonePurgedCacheKey(auth.username, projectId), this.tombstonePurged[projectId] ?? [])
    },
    /** 把条目写进某月份的分片桶（只去重，不按 updatedAt 裁剪：分片月份决定生死） */
    _putShardEntries(projectId: string, month: string, entries: TombstoneEntry[]): void {
      if (!entries.length) return
      const cur = (this.tombstoneShards[projectId] ?? {})[month] ?? []
      this.tombstoneShards[projectId] = {
        ...(this.tombstoneShards[projectId] ?? {}),
        [month]: dedupeTombstones([...cur, ...entries]),
      }
    },
    /** 把 purged 条目写进长库（保留 180 天裁剪）+ 当月分片副本 */
    _putPurgedEntries(projectId: string, month: string, entries: TombstoneEntry[]): void {
      if (!entries.length) return
      this.tombstonePurged[projectId] = pruneTombstones([...(this.tombstonePurged[projectId] ?? []), ...entries])
      this._putShardEntries(projectId, month, entries)
    },
    /** 把离开活跃列表的任务 upsert 进墓碑日志：普通墓碑进当月分片，purged 进长库 + 当月副本。
     *  应在「任务移入回收站」的同一操作中调用（先墓碑、后 tasks.json 移除可见）。 */
    async upsertTombstones(projectId: string, tasks: Array<Pick<Task, 'id' | 'updatedAt'>>) {
      const entries: TombstoneEntry[] = tasks
        .filter((t) => t && t.id && t.updatedAt)
        .map((t) => ({ id: t.id, updatedAt: t.updatedAt }))
      if (!entries.length) return
      const month = monthOfNow()
      const purged = entries.filter((e) => e.id.startsWith(PURGED_TOMBSTONE_PREFIX))
      const normal = entries.filter((e) => !e.id.startsWith(PURGED_TOMBSTONE_PREFIX))
      this._putShardEntries(projectId, month, normal)
      this._putPurgedEntries(projectId, month, purged)
      // 先排定防抖、后写 IDB：调用方可能紧跟着 saveTombstonesNow 冲刷（softDelete 的 void 调用场景），
      // 若顺序颠倒会漏取消防抖，导致冲刷后仍产生一次重复写盘
      ensureTombstoneDebouncer(this, projectId)()
      await this._persistTombstonesLocal(projectId)
      // F3 写前队列
      this.markDirtyPid(projectId)
    },
    /** 从墓碑日志移除指定 id（恢复任务/项目、导入覆盖时调用），整文件替换语义保证删除传播到其他设备。
     *  只删「近窗分片 + purged 长库」：更早分片里的同名条目永不被读，天然失效，无需也不应枚举删除。 */
    async removeTombstones(projectId: string, ids: string[]) {
      if (!ids.length) return
      if (!this.tombstonesReady(projectId)) return
      const targets = new Set(ids)
      const month = monthOfNow()
      let changed = false
      for (const m of tombstoneWindowMonths(month)) {
        const cur = (this.tombstoneShards[projectId] ?? {})[m] ?? []
        const next = cur.filter((e) => !targets.has(e.id))
        if (next.length !== cur.length) {
          this.tombstoneShards[projectId] = {
            ...(this.tombstoneShards[projectId] ?? {}),
            [m]: next,
          }
          changed = true
        }
      }
      // 永久删除命名空间的标记也一并清（恢复同 id 时不该留下 purged 副本）
      const purgedCur = this.tombstonePurged[projectId] ?? []
      const purgedNext = purgedCur.filter((e) => !ids.some((id) => e.id === purgedTombstoneId(id)))
      if (purgedNext.length !== purgedCur.length) {
        this.tombstonePurged[projectId] = purgedNext
        changed = true
      }
      if (!changed) return
      ensureTombstoneDebouncer(this, projectId)()
      await this._persistTombstonesLocal(projectId)
      // F3 写前队列
      this.markDirtyPid(projectId)
    },
    /** 墓碑日志立即落盘（取消防抖，供确认式操作 / 逐出前冲刷使用）；失败不弹错误，返回 false。
     *  失败时自动重新排定防抖重试（防抖重试与确认式保存互补，保证墓碑最终落盘）。 */
    async saveTombstonesNow(projectId: string): Promise<boolean> {
      tombstoneDebouncers.get(projectId)?.cancel()
      const prev = tombstonesSaving.get(projectId)
      if (prev) await prev.catch(() => {})
      const p = this.saveTombstones(projectId).finally(() => {
        if (tombstonesSaving.get(projectId) === p) tombstonesSaving.delete(projectId)
      })
      tombstonesSaving.set(projectId, p)
      const ok = await p
      if (!ok) ensureTombstoneDebouncer(this, projectId)()
      return ok
    },
    /** 墓碑 CAS 写盘：① 当月分片（普通墓碑 + 当月 purged 副本）② purged 长库（仅在有 purged 时）。
     *  两步独立 CAS，冲突均按 id 取 updatedAt 新者合并后重试；普通墓碑不按时间裁剪。 */
    async saveTombstones(projectId: string, snapshot?: TombstoneEntry[]): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      const month = monthOfNow()
      // snapshot 兼容旧调用（回填写盘）：整体视为「当月分片」内容
      const shardEntries = dedupeTombstones(
        snapshot ?? (this.tombstoneShards[projectId] ?? {})[month] ?? [],
      )
      // 未分类：不存在 projects/<id>/ 目录，仍写用户级单文件（普通墓碑 + purged 混存）
      if (!tombstoneSharded(projectId)) {
        try {
          const ok = await this._putTombstoneLegacySingle(client, auth.username, projectId, shardEntries)
          if (ok) this.clearDirtyPid(projectId)
          return ok
        } catch (e) {
          console.warn('未分类墓碑保存失败（可容忍，下轮重试）', projectId, e)
          return false
        }
      }
      const purgedEntries = pruneTombstones(this.tombstonePurged[projectId] ?? [])
      let ok = true
      try {
        ok = await this._putTombstoneShard(client, auth.username, projectId, month, shardEntries)
      } catch (e) {
        console.warn('墓碑分片保存失败（可容忍，下轮重试）', projectId, month, e)
        ok = false
      }
      // purged 为空时跳过第二次 PUT（绝大多数删除都是普通删除，不付双写成本）
      if (purgedEntries.length) {
        try {
          ok = (await this._putTombstonePurged(client, auth.username, projectId, purgedEntries)) && ok
        } catch (e) {
          console.warn('永久删除墓碑保存失败（可容忍，下轮重试）', projectId, e)
          ok = false
        }
      }
      if (ok) this.clearDirtyPid(projectId)
      return ok
    },
    /** CAS 写单个墓碑分片；冲突时按 id 合并后重试 */
    async _putTombstoneShard(
      client: OssClient,
      username: string,
      projectId: string,
      month: string,
      entries: TombstoneEntry[],
    ): Promise<boolean> {
      const key = tombstoneShardPath(username, projectId, month)
      const etagKey = tombstoneShardEtagKey(username, projectId, month)
      const cacheKey = tombstoneShardCacheKey(username, projectId, month)
      let next = [...entries]
      let knownEtag = await idbGet<string>('kv', etagKey)
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<TombstoneEntry[]>(client, key, next, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
          await idbDel('kv', lmKeyOf(etagKey))
          await idbPut('kv', cacheKey, next)
          return true
        }
        if (result.remote) {
          // 冲突：合并两端（同 id 保留 updatedAt 新者）后重试，不丢失任一端删除证据
          next = dedupeTombstones([...(result.remote as TombstoneEntry[]), ...next])
          knownEtag = result.remoteEtag ?? undefined
        } else {
          knownEtag = undefined
        }
      }
      return false
    },
    /** CAS 写 purged 长库；冲突时裁剪合并后重试 */
    async _putTombstonePurged(
      client: OssClient,
      username: string,
      projectId: string,
      entries: TombstoneEntry[],
    ): Promise<boolean> {
      if (!tombstoneSharded(projectId)) {
        // 未分类：单文件同时承载普通墓碑 + purged（沿用旧行为）
        return this._putTombstoneLegacySingle(client, username, projectId, entries)
      }
      const key = tombstonesFilePath(username, projectId)
      const etagKey = tombstonePurgedEtagKey(username, projectId)
      const cacheKey = tombstonePurgedCacheKey(username, projectId)
      let next = [...entries]
      let knownEtag = await idbGet<string>('kv', etagKey)
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<TombstoneEntry[]>(client, key, next, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          await idbDel('kv', lmKeyOf(etagKey))
          await idbPut('kv', cacheKey, next)
          return true
        }
        if (result.remote) {
          next = pruneTombstones([...(result.remote as TombstoneEntry[]), ...next])
          knownEtag = result.remoteEtag ?? undefined
        } else {
          knownEtag = undefined
        }
      }
      return false
    },

    /** 未分类（projectId 为空串）的单文件墓碑：普通墓碑 + purged 混存（沿用旧行为，不再分片） */
    async _putTombstoneLegacySingle(
      client: OssClient,
      username: string,
      projectId: string,
      entries: TombstoneEntry[],
    ): Promise<boolean> {
      const key = tombstonesFilePath(username, projectId)
      const etagKey = tombstonePurgedEtagKey(username, projectId)
      const cacheKey = tombstonePurgedCacheKey(username, projectId)
      let next = [...entries]
      let knownEtag = await idbGet<string>('kv', etagKey)
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<TombstoneEntry[]>(client, key, next, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          await idbDel('kv', lmKeyOf(etagKey))
          await idbPut('kv', cacheKey, next)
          return true
        }
        if (result.remote) {
          // 未分类单文件：两端都可能是「普通墓碑 + purged」混存，按 id 合并后再裁剪
          next = pruneTombstones(dedupeTombstones([...(result.remote as TombstoneEntry[]), ...next]))
          knownEtag = result.remoteEtag ?? undefined
        } else {
          knownEtag = undefined
        }
      }
      return false
    },

    /** 剔除内存 + IDB 里「已被他端永久删除」的回收站记录（多端复活的源头）。
     *  回收站分片是按「只在一侧出现就保留」的并集合并：本端陈旧内存/IDB 缓存会把别端已永久
     *  删除的记录并回、并写进 OSS。这里只动本地缓存，不写 OSS（OSS 由 saveTrash 的写前过滤负责）。
     *  返回被剔除的条数。 */
    async _dropPurgedTrash(projectId: string): Promise<number> {
      const purged = purgedTaskIds(this.tombstonesOf(projectId))
      if (!purged.size) return 0
      const list = this.trash[projectId] ?? []
      if (!list.length) return 0
      const dropped = list.filter((t) => purged.has(t.id))
      if (!dropped.length) return 0
      this.trash[projectId] = list.filter((t) => !purged.has(t.id))
      const auth = useAuthStore()
      if (auth.username) {
        await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
        if (projectId !== UNCATEGORIZED) {
          // 月份分片缓存里可能也留着同一条：连 etag/lm 一起作废，下次强制按远端真值重拉
          for (const m of new Set(dropped.map((t) => monthOfTask(t)))) {
            await idbDel('trash', trashCacheKey(auth.username, projectId, m))
            await idbDel('kv', `etag:${auth.username}:${projectId}:trash:${m}`)
            await idbDel('kv', lmKeyOf(`etag:${auth.username}:${projectId}:trash:${m}`))
          }
        }
      }
      return dropped.length
    },
    /** 显式重新引入这些 id（导入时间胶囊备份 / 恢复任务）时，清除它们的「永久删除墓碑」。
     *  用户显式操作优先于防复活约束：否则写盘过滤会把刚导入的记录当作已永久删除的记录剔除，
     *  表现为「导入备份后这些记录不见了」。先确保墓碑已就绪，再整文件替换落盘。 */
    async clearPurgedTombstones(projectId: string, ids: string[]): Promise<void> {
      if (!ids.length) return
      // 本端还没加载过该项目的墓碑：先取一次，避免只清掉内存里没有、OSS 上仍存在的标记
      if (!this.tombstonesReady(projectId)) await this.fetchTombstones(projectId, { backfill: false })
      const targets = new Set(ids.map(purgedTombstoneId))
      // purged 证据分两处：长库 + 近窗分片里的当月副本，两处都要清
      const cur = this.tombstonePurged[projectId] ?? []
      const next = cur.filter((e) => !targets.has(e.id))
      const purgedChanged = next.length !== cur.length
      const month = monthOfNow()
      const shards = this.tombstoneShards[projectId] ?? {}
      let shardChanged = false
      const nextShards: Record<string, TombstoneEntry[]> = { ...shards }
      for (const m of tombstoneWindowMonths(month)) {
        const list = shards[m] ?? []
        const filtered = list.filter((e) => !targets.has(e.id))
        if (filtered.length !== list.length) {
          nextShards[m] = filtered
          shardChanged = true
        }
      }
      if (!purgedChanged && !shardChanged) return
      this.tombstonePurged[projectId] = next
      if (shardChanged) this.tombstoneShards[projectId] = nextShards
      await this._persistTombstonesLocal(projectId)
      await this.saveTombstonesNow(projectId)
    },
    /** 条件 GET 单个墓碑分片：返回条目数组；分片不存在返回 null（404），304 用缓存。
     *  异常全部就地降级（返回缓存/空），绝不上抛——墓碑读失败不允许污染同步成败。 */
    async _fetchTombstoneShard(
      client: OssClient,
      username: string,
      projectId: string,
      month: string,
    ): Promise<TombstoneEntry[] | null> {
      const etagKey = tombstoneShardEtagKey(username, projectId, month)
      const lmKey = lmKeyOf(etagKey)
      const cacheKey = tombstoneShardCacheKey(username, projectId, month)
      const fromCache = async (): Promise<TombstoneEntry[]> =>
        (await idbGet<TombstoneEntry[]>('kv', cacheKey)) ?? []
      const lm = await idbGet<string>('kv', lmKey)
      try {
        const res = await client.get(
          tombstoneShardPath(username, projectId, month),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status === 304) return fromCache()
        const parsed = JSON.parse(res.content.toString()) as
          | TombstoneEntry[]
          | { updated_at?: string; entries?: TombstoneEntry[] }
        const list = Array.isArray(parsed) ? parsed : (parsed?.entries ?? [])
        const remote = dedupeTombstones(list)
        await idbPut('kv', cacheKey, remote)
        const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
        if (newEtag) await idbPut('kv', etagKey, newEtag)
        const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
        if (newLm) await idbPut('kv', lmKey, newLm)
        return remote
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        if (err.code === 304 || err.status === 304) return fromCache()
        if (isServerEmptyError(e) || err.status === 404) {
          // 分片不存在：作废 etag/lm，返回 null（调用方据此决定是否补读下月/回填）
          await idbDel('kv', etagKey)
          await idbDel('kv', lmKey)
          return null
        }
        // 网络/权限等错误：本轮用缓存兜底，下轮重试（绝不抛给 syncProject）
        console.warn('墓碑分片拉取失败（降级为缓存）', projectId, month, e)
        return fromCache()
      }
    },
    /** 拉取远端墓碑（分片 + purged 长库，条件 GET / 304 命中零下载）。
     *  - 普通墓碑：读「当月 + 上月」两片（当月 404 时补读下月，吸收月界时钟偏移）；
     *  - purged 长库：默认也读（回收站写前过滤需要）；`opts.purged === false` 时跳过
     *    （活跃列表合并不需要 purged——mergeTombstoneTasks 会跳过它，省一次往返）；
     *  - opts.backfill === false → 分片全缺失时不回填（只读对账场景）；
     *  - 任何失败就地降级为回收站近窗分片墓碑（不写错误标记，下轮重试），绝不上抛。 */
    async fetchTombstones(
      projectId: string,
      opts?: { backfill?: boolean; purged?: boolean },
    ): Promise<TombstoneEntry[]> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return this.tombstonesOf(projectId)
      const client = await createOssClient(auth.creds)
      const month = monthOfNow()
      const pending = hasPendingTombstones(projectId)
      try {
        // 未分类：单文件（不分片），保持旧语义
        if (!tombstoneSharded(projectId)) {
          return await this._fetchTombstoneLegacySingle(client, auth.username, projectId, opts)
        }
        const [prevList, curList] = await Promise.all(
          tombstoneWindowMonths(month).map((m) => this._fetchTombstoneShard(client, auth.username, projectId, m)),
        )
        // 当月分片 404：补读下月（月界附近时钟不同步的一端会写进「下月」）
        let nextList: TombstoneEntry[] | null = null
        const nextM = nextMonth(month)
        if (curList === null) {
          nextList = await this._fetchTombstoneShard(client, auth.username, projectId, nextM)
        }
        const prevM = prevMonth(month)
        // purged：长库 + 落在近窗分片里的副本（LWW 合并；长库缺失视为空）
        let remotePurged = dedupeTombstones([
          ...(prevList ?? []),
          ...(curList ?? []),
          ...(nextList ?? []),
        ]).filter((e) => e.id.startsWith(PURGED_TOMBSTONE_PREFIX))
        if (opts?.purged !== false) {
          const longList = await this._fetchTombstonePurged(client, auth.username, projectId)
          remotePurged = pruneTombstones([...(longList ?? []), ...remotePurged])
        }

        // 按「分片月份」回填各自桶（不能把上月条目塞进当月桶，否则下次写盘会把它们复制进当月分片）：
        //  - 远端存在该分片 → 远端即权威（除非本端有待落盘墓碑，此时并集防抹掉本地证据）；
        //  - 远端 404 → 保留本地桶（可能是尚未落盘的新写），不清空。
        const shards = this.tombstoneShards[projectId] ?? {}
        const mergeInto = (remote: TombstoneEntry[], local: TombstoneEntry[]): TombstoneEntry[] =>
          pending ? dedupeTombstones([...remote, ...local]) : remote
        // 只保留读取窗口内的分片桶（上月/当月/下月），其余一律丢弃：
        // 否则跨月后旧月份桶会一直留在内存与 IDB 里，随月份推移无限累积（且让已过窗的
        // 墓碑继续参与剔除，与「按分片月份生效」的语义不符）。
        const keepMonths = new Set([prevM, month, nextM])
        const nextShards: Record<string, TombstoneEntry[]> = {}
        for (const [m, list] of Object.entries(shards)) {
          if (keepMonths.has(m)) nextShards[m] = list
        }
        if (prevList !== null) nextShards[prevM] = mergeInto(prevList, shards[prevM] ?? [])
        if (curList !== null) nextShards[month] = mergeInto(curList, shards[month] ?? [])
        else if (pending) nextShards[month] = shards[month] ?? []
        if (nextList !== null) nextShards[nextM] = mergeInto(nextList, shards[nextM] ?? [])
        this.tombstoneShards[projectId] = nextShards
        const purgedView = pending
          ? pruneTombstones([...(this.tombstonePurged[projectId] ?? []), ...remotePurged])
          : remotePurged
        this.tombstonePurged[projectId] = purgedView
        this.setTombstonesReady(projectId, true)
        await this._persistTombstonesLocal(projectId)

        // 两片都缺失（首次使用 / 全部过期）且允许回填：从回收站近窗分片剥一份墓碑写进当月分片
        const allMissing = prevList === null && curList === null && nextList === null
        if (allMissing && opts?.backfill !== false && !(nextShards[month] ?? []).length) {
          await this._backfillTombstonesFromTrash(client, auth.username, projectId, month)
        }
        return this.tombstonesOf(projectId)
      } catch (e) {
        // 兜底：整段读失败（如创建 client 前就异常）→ 用回收站近窗分片剥墓碑
        console.warn('墓碑日志拉取失败（降级为回收站近窗分片）', projectId, e)
        try {
          const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
          return dedupeTombstones(remoteTrash.map((t) => ({ id: t.id, updatedAt: t.updatedAt })))
        } catch {
          return this.tombstonesOf(projectId)
        }
      }
    },
    /** 拉取 purged 长库（tombstones.json）；不存在返回 null。异常就地降级（返回缓存） */
    async _fetchTombstonePurged(
      client: OssClient,
      username: string,
      projectId: string,
    ): Promise<TombstoneEntry[] | null> {
      const etagKey = tombstonePurgedEtagKey(username, projectId)
      const lmKey = lmKeyOf(etagKey)
      const cacheKey = tombstonePurgedCacheKey(username, projectId)
      const fromCache = async (): Promise<TombstoneEntry[]> =>
        (await idbGet<TombstoneEntry[]>('kv', cacheKey)) ?? []
      const lm = await idbGet<string>('kv', lmKey)
      try {
        const res = await client.get(
          tombstonesFilePath(username, projectId),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status === 304) return fromCache()
        const parsed = JSON.parse(res.content.toString()) as
          | TombstoneEntry[]
          | { updated_at?: string; entries?: TombstoneEntry[] }
        const list = Array.isArray(parsed) ? parsed : (parsed?.entries ?? [])
        // 旧版混存文件：这里只取 purged 条目（普通墓碑已下沉到分片，按月份决定生死）
        const remote = pruneTombstones(list.filter((e) => e?.id?.startsWith(PURGED_TOMBSTONE_PREFIX)))
        await idbPut('kv', cacheKey, remote)
        const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
        if (newEtag) await idbPut('kv', etagKey, newEtag)
        const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
        if (newLm) await idbPut('kv', lmKey, newLm)
        return remote
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        if (err.code === 304 || err.status === 304) return fromCache()
        if (isServerEmptyError(e) || err.status === 404) {
          await idbDel('kv', etagKey)
          await idbDel('kv', lmKey)
          return null
        }
        console.warn('永久删除墓碑长库拉取失败（降级为缓存）', projectId, e)
        return fromCache()
      }
    },
    /** 未分类单文件墓碑（不分片）：普通墓碑 + purged 混存，保持旧语义（按 updatedAt 裁剪 180 天） */
    async _fetchTombstoneLegacySingle(
      client: OssClient,
      username: string,
      projectId: string,
      opts?: { backfill?: boolean; purged?: boolean },
    ): Promise<TombstoneEntry[]> {
      const etagKey = tombstonePurgedEtagKey(username, projectId)
      const lmKey = lmKeyOf(etagKey)
      const cacheKey = tombstonePurgedCacheKey(username, projectId)
      const pending = hasPendingTombstones(projectId)
      const localView = (this.tombstoneShards[projectId]?.[monthOfNow()] ?? [])
      const fromCache = async (): Promise<TombstoneEntry[]> => {
        const cached = (await idbGet<TombstoneEntry[]>('kv', cacheKey)) ?? []
        return pending ? dedupeTombstones([...cached, ...localView]) : cached
      }
      const lm = await idbGet<string>('kv', lmKey)
      try {
        const res = await client.get(
          tombstonesFilePath(username, projectId),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status === 304) return fromCache()
        const parsed = JSON.parse(res.content.toString()) as
          | TombstoneEntry[]
          | { updated_at?: string; entries?: TombstoneEntry[] }
        const list = Array.isArray(parsed) ? parsed : (parsed?.entries ?? [])
        const remote = pruneTombstones(list)
        const entries = pending
          ? pruneTombstones(dedupeTombstones([...remote, ...(await fromCache())]))
          : remote
        this.tombstoneShards[projectId] = {
          ...(this.tombstoneShards[projectId] ?? {}),
          [monthOfNow()]: entries,
        }
        this.setTombstonesReady(projectId, true)
        await idbPut('kv', cacheKey, entries)
        const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
        if (newEtag) await idbPut('kv', etagKey, newEtag)
        const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
        if (newLm) await idbPut('kv', lmKey, newLm)
        return entries
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        if (err.code === 304 || err.status === 304) return fromCache()
        if (isServerEmptyError(e) || err.status === 404) {
          return fromCache()
        }
        // 未分类单文件读失败：降级为缓存，绝不上抛（与分片路径一致）
        console.warn('未分类墓碑日志拉取失败（降级为缓存）', projectId, e)
        return fromCache()
      }
    },
    /** 从回收站近窗分片剥出墓碑，写进当月分片并落盘（一次性成本，尽力而为不阻塞） */
    async _backfillTombstonesFromTrash(
      client: OssClient,
      username: string,
      projectId: string,
      month: string,
    ): Promise<void> {
      try {
        const remoteTrash = await fetchRemoteTrash(client, username, projectId)
        if (!remoteTrash.length) return
        const entries = dedupeTombstones(remoteTrash.map((t) => ({ id: t.id, updatedAt: t.updatedAt })))
        this._putShardEntries(projectId, month, entries)
        void this.saveTombstones(projectId, entries).then((ok) => {
          if (!ok) ensureTombstoneDebouncer(this, projectId)()
        })
      } catch {
        /* 回填失败不阻塞，下轮重试 */
      }
    },
    /** 组装防复活墓碑集合：本地日志 + 远端日志（缺失回填/失败降级）+ 任务文件内 deleted 残留。
     *  供 syncProject / saveProject 冲突合并 / _loadProjectInner 统一调用。
     *  注意：purged 条目对活跃列表合并没有意义（mergeTombstoneTasks 会跳过前缀），
     *  因此这里跳过 purged 长库读取，省一次往返（热路径只碰 2 个分片）。 */
    async collectTombstones(projectId: string, remoteDeleted: Task[]): Promise<Task[]> {
      let remote: TombstoneEntry[] = []
      try {
        remote = await this.fetchTombstones(projectId, { purged: false })
      } catch {
        remote = []
      }
      return mergeTombstoneTasks(this.tombstonesOf(projectId), remote, remoteDeleted)
    },

    /** 立即保存该项目任务（取消防抖，供“确认式保存”使用）；成功返回 true，失败返回 false（已弹错误提示）。
     *  同一文件已有在途保存时先等待其落盘，再写入最新状态，避免并发互相覆盖。 */
    async saveProjectNow(projectId: string, snapshot?: Task[]): Promise<boolean> {
      saveDebouncers.get(projectId)?.cancel()
      const prev = tasksSaving.get(projectId)
      if (prev) await prev.catch(() => {})
      const p = this.saveProject(projectId, snapshot).finally(() => {
        if (tasksSaving.get(projectId) === p) tasksSaving.delete(projectId)
      })
      tasksSaving.set(projectId, p)
      return p
    },
    /** 立即保存该项目回收站（取消防抖，供“确认式保存”使用）；成功返回 true。
     *  可传 snapshot 覆盖内存内容（失败回滚场景：把已写入 OSS 的分片还原为保存前快照）。 */
    async saveTrashNow(projectId: string, snapshot?: Task[]): Promise<boolean> {
      trashDebouncers.get(projectId)?.cancel()
      const prev = trashSaving.get(projectId)
      if (prev) await prev.catch(() => {})
      const p = this.saveTrash(projectId, snapshot).finally(() => {
        if (trashSaving.get(projectId) === p) trashSaving.delete(projectId)
      })
      trashSaving.set(projectId, p)
      return p
    },
    /** 立即保存该项目重复模板（供确认式保存使用，与即时保存共用同一在途 Promise）；成功返回 true */
    async saveRepeatsNow(projectId: string): Promise<boolean> {
      const prev = repeatsSaving.get(projectId)
      if (prev) await prev.catch(() => {})
      const p = this.saveRepeats(projectId).finally(() => {
        if (repeatsSaving.get(projectId) === p) repeatsSaving.delete(projectId)
      })
      repeatsSaving.set(projectId, p)
      return p
    },
    /** 供项目仓库回滚使用：恢复指定项目的任务/回收站/重复模板/墓碑日志（内存 + IDB） */
    async rollbackProject(
      projectId: string,
      snap: {
        tasks?: Task[]
        trash?: Task[]
        repeats?: RepeatMaster[]
        tombstones?: {
          shards: Record<string, TombstoneEntry[]>
          purged: TombstoneEntry[]
          loaded: boolean
        }
      },
    ): Promise<void> {
      const auth = useAuthStore()
      if (snap.tasks !== undefined) {
        this.tasks[projectId] = snap.tasks
        await idbPut('tasks', taskCacheKey(auth.username, projectId), snap.tasks)
      }
      if (snap.trash !== undefined) {
        this.trash[projectId] = snap.trash
        await idbPut('trash', trashCacheKey(auth.username, projectId), snap.trash)
      }
      if (snap.repeats !== undefined) {
        this.repeats[projectId] = snap.repeats
        await idbPut('repeats', repeatsCacheKey(auth.username, projectId), snap.repeats)
      }
      if (snap.tombstones !== undefined) {
        await this.restoreTombstones(projectId, snap.tombstones)
        // 回滚后把还原的墓碑日志写回 OSS：避免「删除失败回滚后，其它设备仍按旧墓碑误杀任务」
        await this.saveTombstonesNow(projectId)
      }
    },
    /** 拉取重复模板（独立文件，按需加载，仅主任务完成后生成） */
    async loadRepeats(projectId: string, force = false) {
      this.touchProject(projectId)
      const auth = useAuthStore()
      // 会话内只加载一次（force=true 时强制重拉）：收到其它端的 repeats 变更时必须
      // 强制刷新，否则会话早期加载的陈旧模板（含被别端删除的规则）会一直留在内存里，
      // 下一次 saveRepeats 就把已删除规则并集写回（R4 复活路径的入口）。
      if (!force && this.repeatsLoaded.includes(projectId)) return
      const cached = await idbGet<RepeatMaster[]>('repeats', repeatsCacheKey(auth.username, projectId))
      if (cached) this.repeats[projectId] = cached
      if (!auth.creds || !auth.username) return
      const etagKey = `etag:${auth.username}:${projectId}:repeats`
      const lmKey = lmKeyOf(etagKey)
      try {
        const client = await createOssClient(auth.creds)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          repeatsFilePath(auth.username, projectId),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as RepeatMaster[]
          this.repeats[projectId] = remote ?? []
          await idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId])
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', etagKey, newEtag)
          const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
          if (newLm) await idbPut('kv', lmKey, newLm)
        }
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        const is304 = err.code === 304 || err.status === 304
        if (is304) {
          // 缓存与云端一致，无需处理
        } else if (isServerEmptyError(e)) {
          // 服务端重复模板文件已不存在：本地缓存作废
          this.repeats[projectId] = []
          await idbDel('repeats', repeatsCacheKey(auth.username, projectId))
          await idbDel('kv', etagKey)
          await idbDel('kv', lmKey)
        } else {
          throw new Error(await enrichOssError(e))
        }
      }
      if (!this.repeatsLoaded.includes(projectId)) this.repeatsLoaded.push(projectId)
    },
    /** 保存重复模板到 OSS（CAS 冲突合并，避免多端互相覆盖） */
    async saveRepeats(projectId: string, snapshot?: RepeatMaster[]): Promise<boolean> {
      savingNow.add(projectId)
      try {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      let list = (snapshot ?? this.repeats[projectId] ?? []).slice()
      const key = repeatsFilePath(auth.username, projectId)
      const etagKey = `etag:${auth.username}:${projectId}:repeats`
      let knownEtag = await idbGet<string>('kv', etagKey)
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await compareAndSwapPut<RepeatMaster[]>(client, key, list, knownEtag)
          if (result.ok) {
            if (result.etag) await idbPut('kv', etagKey, result.etag)
            // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
            await idbDel('kv', lmKeyOf(etagKey))
            await idbPut('repeats', repeatsCacheKey(auth.username, projectId), list)
            queueSyncChange(auth.username, 'repeats', projectId)
            // F3 写前队列：重复模板已成功落盘 → 清除脏标记
            this.clearDirtyPid(projectId)
            return true
          }
          // 冲突：墓碑感知 + last-writer-wins 合并（R4 修复，替代按 id 简单并集）——
          // 避免一端已删除的重复规则被离线端缓存的旧 master 并集写回复活
          if (result.reason === 'remote-gone') {
            // 远端文件被清空/重置（R3 同族）：作废本地缓存，禁止把缓存当作新建写回
            this.repeats[projectId] = []
            await idbDel('repeats', repeatsCacheKey(auth.username, projectId))
            await idbDel('kv', etagKey)
            await idbDel('kv', lmKeyOf(etagKey))
            // F3 写前队列：本地缓存已作废，脏标记一并清除
            this.clearDirtyPid(projectId)
            return true
          }
          if (result.remote) {
            const remote = result.remote as RepeatMaster[]
            const merged = mergeRepeatMasters(list, remote)
            list = merged
            knownEtag = result.remoteEtag ?? undefined
            if (!snapshot) {
              this.repeats[projectId] = list
              await idbPut('repeats', repeatsCacheKey(auth.username, projectId), list)
            }
          } else {
            // 远端为空但发生创建竞态：重拉远端内容后再试
            knownEtag = undefined
          }
        }
        useUiStore().toast('保存重复任务失败：检测到其他设备持续修改，请稍后重试', 'error')
        return false
      } catch (e) {
        console.error('保存重复任务到 OSS 失败', e)
        useUiStore().toast(`保存重复任务失败：${describeOssError(e)}`, 'error')
        return false
      }
      } finally {
        savingNow.delete(projectId)
      }
    },
    /** 重复模板变更持久化（立即保存，完成/删除模板属低频操作） */
    _persistRepeats(projectId: string) {
      const auth = useAuthStore()
      void idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId] ?? [])
      void this.saveRepeatsNow(projectId)
      this._syncReminders()
      // F3 写前队列
      this.markDirtyPid(projectId)
    },
    /**
     * 重复任务物化：到期的重复模板生成可见任务（新 id、pending，时间按周期顺延）；
     * 过期多日时跳过缺失周期，只保留“今天”这一次（跳过≠补发）；endAfter 已过则删除模板。
     * 物化后模板删除，由该物化任务自己承担后续周期（再次完成时重新生成模板）。
     * 在加载 / 同步 / 跨天检测时调用，不在普通编辑 _persist 里调用。
     */
    async materializeRepeats(projectId?: string, forceRefresh = false) {
      // 串行调度：轮询同步 / 跨天定时器 / 打开项目可能并发触发物化，同一批到期模板被并发
      // 读取会重复生成两份任务。串行后第二个调用基于第一个已完成的状态执行（到期模板已被
      // 移除），不会重复物化；队列内单个调用失败只影响该调用，不阻断后续物化。
      const run = materializeChain.then(() => this._materializeRepeats(projectId, forceRefresh))
      materializeChain = run.catch(() => undefined)
      return run
    },
    /** 实际的到期物化逻辑（由 materializeRepeats 串行调度后执行，避免并发重复生成） */
    async _materializeRepeats(projectId?: string, forceRefresh = false) {
      const auth = useAuthStore()
      const today = todayKey()
      const pids = projectId ? [projectId] : Object.keys(this.repeats)
      for (const pid of pids) {
        try {
          // forceRefresh：拉取到变更后立即物化时必须先对账远端，否则会话早期加载的
          // 陈旧模板（含被别端删除的规则）会基于未对账缓存物化出任务 / 把规则写回
          if (!this.repeatsLoaded.includes(pid) || forceRefresh) await this.loadRepeats(pid, forceRefresh)
          const masters = this.repeats[pid] ?? []
          if (!masters.length) continue
          const remaining: RepeatMaster[] = []
          const toAdd: Task[] = []
          let changed = false
          for (const master of masters) {
            if (master.deletedAt) {
              // 墓碑：规则已被删除，保留墓碑随文件传播删除，不参与物化
              remaining.push(master)
              continue
            }
            const rule = master.template.repeat
            if (!rule) {
              changed = true
              continue
            }
            const endAfter = rule.endAfter
            let dueDate = master.dueDate
            // 过期多日：跳过缺失周期，推进到 >= 今天的最近一次
            let guard = 0
            while (dueDate < today && guard < 400) {
              const nd = nextRepeatDate(rule, dueDate)
              if (!nd || nd <= dueDate) break
              dueDate = nd
              guard++
            }
            // 单日已处理（提前完成/入舱）的重复日：跳过该日并推进到下一次，
            // 已经完成/入舱的那一天绝不重新物化生成或覆盖；未处理日不受影响
            const rootId = master.rootTaskId ?? master.template.repeatRootId ?? master.id
            const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
            const processed = root?.repeatProcessed ?? master.template.repeatProcessed
            while (processed?.[dueDate] && guard < 400) {
              const nd = nextRepeatDate(rule, dueDate)
              if (!nd || nd <= dueDate) break
              dueDate = nd
              guard++
            }
            if (processed?.[dueDate]) continue
            if (endAfter && dueDate > endAfter) {
              // 结束日期已过：不再生成，删除模板（周期提醒随之停止）
              changed = true
              continue
            }
            if (dueDate > today) {
              // 今天的周期还没到：仅按日期平移模板时间，等待到期
              if (dueDate !== master.dueDate) {
                remaining.push({
                  ...master,
                  dueDate,
                  template: shiftTaskTimes(master.template, diffDaysKey(master.dueDate, dueDate)),
                  updatedAt: nowIso(),
                })
                changed = true
              } else {
                remaining.push(master)
              }
              continue
            }
            // dueDate == today：物化为可见任务
            // 沿用 master.template.id 作为任务 id：同一重复模板（同一到期日）在多端/多次触发时
            // 生成的任务 id 一致（新数据为确定性派生 id），配合下方 list.some(id) 检查与
            // 跨端 mergeTasks（按 id 合并），可避免把同一个重复任务重复生成两份。
            const template = shiftTaskTimes(master.template, diffDaysKey(master.dueDate, dueDate))
            toAdd.push({
              ...template,
              id: master.template.id,
              status: 'pending',
              isReminded: false,
              createdAt: nowIso(),
              // updatedAt 继承模板的最后修改时间（而非物化时刻）：让跨端 last-writer-wins
              // 按“编辑时间”而非“物化时间”比较，避免一端用陈旧模板物化出的旧时间把
              // 另一端已编辑的新时间覆盖掉（重复任务 Bug 的 lost-update 变体）
              updatedAt: master.updatedAt || master.template.updatedAt || nowIso(),
            })
            changed = true
          }
          if (changed) {
            this.repeats[pid] = remaining
            if (this.syncCatchingUp) {
              // F1：追平门闩——模板落盘延迟到追平后（IDB 显式写入，保证缓存与内存一致）
              await idbPut('repeats', repeatsCacheKey(auth.username, pid), this.repeats[pid])
              this.deferWriteback(pid)
            } else {
              this._persistRepeats(pid)
            }
          }
          if (toAdd.length) {
            const list = this.tasks[pid] ?? []
            const next = [...list]
            for (const task of toAdd) {
              if (next.some((t) => t.id === task.id)) continue
              // 物化出的重复任务沿用模板自带的 sort（来自其源重复任务，通常已在重复区），
              // 再交给 sortActiveList 统一就位：不重编 sort 也不会打乱用户手动位置，
              // 同时保留「updatedAt 继承模板」的跨端语义（改 updatedAt 会让陈旧物化覆盖他端编辑）。
              next.push(task)
              // 物化出的重复任务（当日可见的待办）由 reconcileTodayOrder 统一登记进 todayOrder；
              // 完成/删除时对账会把它从顺序表移除，不会无限累积。
              logAudit('生成重复任务', safeDetail(`任务ID：${task.id}，项目ID：${pid}，周期：${task.repeat?.type ?? ''}`))
            }
            // 自愈去重兜底：即便极端情况下出现 id 不同的同链同日重复（旧随机 id 数据/竞态），
            // 也收敛为一条，不再写回两条
            const cleaned = await this._selfHealRepeatDuplicates(pid, next)
            this.tasks[pid] = sortActiveList(cleaned)
            if (this.syncCatchingUp) {
              // F1：追平门闩——任务落盘延迟到追平后（IDB 显式写入）
              await idbPut('tasks', taskCacheKey(auth.username, pid), this.tasks[pid])
              this.deferWriteback(pid)
            } else {
              this._persist(pid)
            }
          }
        } catch (e) {
          // 单个项目对账/物化失败（离线等）不影响其它项目：本轮跳过，等待下次同步成功后再触发。
          // 绝不基于未对账的缓存数据物化，避免把同一条重复生成两份。
          console.warn('重复任务物化失败（跳过，等待下次同步）', pid, e)
        }
      }
      // 物化完成后统一对账：把刚物化的当日实例按时间登记进今日顺序表
      this.reconcileTodayOrder()
    },
    /** 自愈去重（重复任务 Bug 兜底）：对某项目的活跃任务列表执行重复收敛，
     *  规则 A 的墓碑写入回收站、规则 B 的模板写回 repeats，返回收敛后的活跃列表。
     *  应在内存/OSS 已对账的列表上调用（_loadProjectInner / syncProject / _materializeRepeats）；
     *  无凭据（未登录）时只改内存 + IDB，落盘调用静默跳过。 */
    async _selfHealRepeatDuplicates(projectId: string, list: Task[]): Promise<Task[]> {
      const { list: cleaned, tombstoned, masters } = dedupRepeatOccurrences(list)
      if (!tombstoned.length && !masters.length) return cleaned
      const auth = useAuthStore()
      if (tombstoned.length) {
        this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], tombstoned)
        await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
        if (this.syncCatchingUp) {
          // F1：追平门闩——自愈写回延迟到追平后统一收敛（内存 + IDB 已更新，展示不受影响；
          // 墓碑仅入本地，防复活依据仍在，追平后由 finalizeSyncCatchUp 落盘）
          await this.upsertTombstonesLocalOnly(projectId, tombstoned)
          this.deferWriteback(projectId)
        } else {
          // 自愈去重入回收站的任务同样写墓碑：防止陈旧设备把重复行并回活跃列表复活
          await this.upsertTombstones(projectId, tombstoned)
          void this._persistTrash(projectId, true)
        }
        logAudit('重复任务去重', safeDetail(`项目ID：${projectId}，移除重复 ${tombstoned.length} 条`))
      }
      if (masters.length) {
        const existing = this.repeats[projectId] ?? []
        const newMasters = masters.filter((m) => !existing.some((e) => e.id === m.id))
        if (newMasters.length) {
          this.repeats[projectId] = [...existing, ...newMasters]
          await idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId])
          if (this.syncCatchingUp) {
            // F1：追平门闩——模板落盘延迟到追平后统一收敛
            this.deferWriteback(projectId)
          } else {
            void this.saveRepeatsNow(projectId)
          }
          logAudit('重复任务去重', safeDetail(`项目ID：${projectId}，恢复重复模板 ${newMasters.length} 条`))
        }
      }
      return cleaned
    },
    /** 自愈清理孤儿副本（跨项目转成子任务的残留 Bug 兜底）：把任务 A 拖成任务 B 的子任务时，
     *  A 不再携带 projectId（Subtask 无此字段），源项目里残留的 A 旧副本无法被
     *  filterStaleAcrossProjects（只比较顶层数组）识别，对端合并会按「只在一侧出现则保留」
     *  把 A 并回源项目 → 顶层 A 与子任务 A 同时存在（复制）。
     *  这里扫描本项目顶层数组中 id 同时出现在「任一已加载项目任一任务的 subtasks」里的任务，
     *  判定为孤儿残留（两层数据模型下，同 id 不可能合法地既在顶层又在某任务子任务里），
     *  移除并写墓碑（防对端复活）。应在内存/OSS 已对账的列表上调用
     *  （_loadProjectInner / syncProject / CAS 冲突合并），与 _selfHealRepeatDuplicates 同级。
     *  时序兜底（防误删）：转换时子任务 updatedAt=now ≥ source.updatedAt，故仅当本项目这份
     *  顶层副本“不晚于”它作为子任务出现的时间才清理；若顶层副本被用户后续编辑过
     *  （updatedAt 更新）则保留，避免把仍在使用/已还原的任务误删（BUG：来回拖拽子任务后任务消失）。 */
    async _selfHealOrphanSubtasks(projectId: string, list: Task[]): Promise<Task[]> {
      if (!list.length) return list
      // 收集所有已加载项目顶层任务的子任务 id → 其最新 updatedAt（含本项目：
      // 同项目转换同样可能残留；首载时 this.tasks[projectId] 尚未赋值，需把当前 list 自身的子任务一并纳入）
      const subInfo = new Map<string, string>()
      const track = (ts: Task[]) => {
        for (const t of ts) {
          for (const s of t.subtasks ?? []) {
            const cur = subInfo.get(s.id)
            if (!cur || (s.updatedAt || '').localeCompare(cur) > 0) subInfo.set(s.id, s.updatedAt || '')
          }
        }
      }
      for (const [, ts] of Object.entries(this.tasks)) track(ts)
      track(list)
      if (!subInfo.size) return list
      const orphans = list.filter((t) => {
        const subAt = subInfo.get(t.id)
        if (subAt === undefined) return false
        // 顶层副本有 updatedAt 且晚于子任务出现 → 可能被后续编辑/还原，保留
        const topAt = t.updatedAt || ''
        if (topAt && topAt > subAt) return false
        return true
      })
      if (!orphans.length) return list
      if (this.syncCatchingUp) {
        // F1：追平门闩——墓碑落盘延迟到追平后统一收敛（内存 + IDB 已更新，防复活依据仍在本地）
        await this.upsertTombstonesLocalOnly(
          projectId,
          orphans.map((t) => ({ id: t.id, updatedAt: t.updatedAt })),
        )
        this.deferWriteback(projectId)
      } else {
        // 写墓碑（防对端按并集合并复活）→ 移除顶层残留
        await this.upsertTombstones(
          projectId,
          orphans.map((t) => ({ id: t.id, updatedAt: t.updatedAt })),
        )
      }
      logAudit('清理孤儿副本', safeDetail(`项目ID：${projectId}，移除 ${orphans.length} 条（已转成其他任务的子任务）`))
      const drop = new Set(orphans.map((t) => t.id))
      return list.filter((t) => !drop.has(t.id))
    },
    /** 把满足条件的重复模板标记为墓碑（R4 修复）：保留在列表内随文件传播删除，
     *  防止离线端把已删规则通过「并集合并」写回复活；已墓碑的不重复标记。
     *  返回被标记的项目集合（调用方决定落盘）。 */
    _tombstoneMasters(pred: (m: RepeatMaster) => boolean): Set<string> {
      const touched = new Set<string>()
      const now = nowIso()
      for (const pid of Object.keys(this.repeats)) {
        const masters = this.repeats[pid] ?? []
        const next = masters.map((m) =>
          !m.deletedAt && pred(m) ? { ...m, deletedAt: now, updatedAt: now } : m,
        )
        if (next.some((m, i) => m !== masters[i])) {
          this.repeats[pid] = next
          touched.add(pid)
        }
      }
      return touched
    },
    /** 删除某任务对应的重复模板（软删/永久删/取消完成/恢复时调用）。
     *  R4 修复：改为写墓碑而非直接移除，删除通过并集合并复活的问题在 mergeRepeatMasters 兜底。 */
    _deleteMasterForTask(taskId: string) {
      const touched = this._tombstoneMasters((m) => m.sourceTaskId === taskId)
      for (const pid of touched) this._persistRepeats(pid)
    },
    /** 编辑「时间胶囊」里的重复任务后同步其重复模板（确认式：立即落盘，成功才返回 true）：
     *  与今日任务编辑（saveTaskConfirmed/upsert）和未来任务编辑（saveFutureOccurrenceConfirmed）
     *  共用统一的 _syncRepeatMasterForTask，这里只负责落盘与失败回滚。
     *  - 规则被移除 → 删除模板（周期停止）；
     *  - 规则保留 → 更新/创建模板（严格晚于今天的下一次出现）；
     *  - 今天的已完成任务保持完成、留在胶囊内不变，绝不额外生成一个「今天」的未完成任务。
     *  跨项目移动时把旧项目里的同源模板一并清除（周期链迁移到新项目）。 */
    async syncRepeatMasterForCapsuleTask(task: Task, prevProjectId?: string): Promise<boolean> {
      // 单日记录（提前完成/入舱生成的 per-day 回收站记录）：编辑它时不再同步重复模板，
      // 避免用 per-day 合成 id 生成/覆盖重复 master，也绝不改动其它未完成出现
      if (task.repeatOccurrence) return true
      const auth = useAuthStore()
      const pid = task.projectId
      if (!pid || pid === UNCATEGORIZED) return true
      if (!this.repeatsLoaded.includes(pid)) await this.loadRepeats(pid)
      // 可能受影响的模板项目 = 目标项目 + 旧项目 + 内存里存在该任务同源模板的项目，全部快照以便回滚
      const snapPids = new Set<string>([pid])
      if (prevProjectId && prevProjectId !== pid) snapPids.add(prevProjectId)
      for (const [p, ms] of Object.entries(this.repeats)) {
        if ((ms ?? []).some((m) => !m.deletedAt && m.sourceTaskId === task.id)) snapPids.add(p)
      }
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      for (const p of snapPids) {
        if (!this.repeatsLoaded.includes(p)) await this.loadRepeats(p)
        repeatsSnap.set(p, (this.repeats[p] ?? []).slice())
      }
      // P1-4 联动可能改到活跃任务（多端竞态下模板的出现已被物化）：一并快照以便失败回滚
      const tasksSnap = new Map<string, Task[]>()
      for (const p of snapPids) {
        tasksSnap.set(p, (this.tasks[p] ?? []).slice())
      }
      // 统一同步逻辑（只改内存 + 返回触及项目）：已完成胶囊任务会创建/更新模板（> 今天），
      // 今天的已完成记录保持完成，不会物化出「今天」的新任务
      const { repeatPids: touched, taskPids } = this._syncRepeatMasterForTask(task)
      const results = await Promise.all([...touched].map((p) => this.saveRepeatsNow(p)))
      const taskResults = await Promise.all([...taskPids].map((p) => this.saveProjectNow(p)))
      if (results.every(Boolean) && taskResults.every(Boolean)) {
        this._syncReminders()
        return true
      }
      // 失败回滚：恢复内存 + IDB，并尽力把已写入 OSS 的模板文件还原为保存前快照
      for (const [p, list] of repeatsSnap) {
        this.repeats[p] = list
        await idbPut('repeats', repeatsCacheKey(auth.username, p), list)
        await this.saveRepeats(p, list).catch(() => {})
      }
      for (const [p, list] of tasksSnap) {
        this.tasks[p] = list
        await idbPut('tasks', taskCacheKey(auth.username, p), list)
        await this.saveProjectNow(p, list).catch(() => {})
      }
      return false
    },
    /**
     * 统一「编辑任务」后的重复模板同步（今日任务 / 时间胶囊 / 未来任务三处共用，杜绝各自独立逻辑）：
     * - 无 task.repeat → 删除 sourceTaskId === task.id 的全部模板（含旧项目残留，跨项目迁移时清旧项目）；
     * - 有 task.repeat：
     *   · 找到既有模板（opts.masterId 优先 / sourceTaskId === task.id）：
     *     - 规则形状未变（repeatShapeEquals，不含 start/endAfter）→ 保留模板 dueDate/相位，
     *       仅按新内容用 buildOccurrenceTemplate 重建（沿用原 template.id），周期相位不重置；
     *     - 规则形状变化 / 老模型 → 按新规则重算「严格晚于今天」的下一次出现
     *       （buildRepeatOccurrence 只取 > 今天，绝不把今天物化成新的未完成任务）：
     *       有出现 → 替换模板（保留原 id/sourceTaskId）；无出现 / 结束日期已过 → 删除模板；
     *   · 未找到模板：仅当任务已完成（时间胶囊/完成态源任务）或显式传入 masterId 时才创建，
     *     活跃的待办任务不提前生成模板（完成时由 _flipComplete 生成，避免编辑普通任务就生成模板）；
     * - 只改内存并返回触及的项目 id（调用方负责落盘，失败自行回滚）。
     *   返回 { repeatPids: 重复模板被改动的项目, taskPids: 因联动被改动的活跃任务所在项目 }。
     */
    _syncRepeatMasterForTask(task: Task, opts?: { masterId?: string }): { repeatPids: Set<string>; taskPids: Set<string> } {
      const touched = new Set<string>()
      const taskPids = new Set<string>()
      const rule = task.repeat
      if (!rule) {
        // 移除重复：把同源全部模板标记为墓碑（跨项目迁移时一并清旧项目残留；R4 防复活）
        const t = this._tombstoneMasters((m) => m.sourceTaskId === task.id)
        for (const p of t) touched.add(p)
        return { repeatPids: touched, taskPids }
      }
      const today = todayKey()
      // 定位既有模板：未来任务编辑按 masterId（模板 id），其余按 sourceTaskId（源任务 id）
      let pid: string | undefined
      let idx = -1
      const findMaster = (pred: (m: RepeatMaster) => boolean): { pid?: string; idx: number } => {
        for (const k of Object.keys(this.repeats)) {
          // 跳过墓碑：已被删除的规则不作为「既有模板」，允许后续重新创建（复活）
          const i = (this.repeats[k] ?? []).findIndex((m) => !m.deletedAt && pred(m))
          if (i >= 0) return { pid: k, idx: i }
        }
        return { idx: -1 }
      }
      if (opts?.masterId) {
        const f = findMaster((m) => m.id === opts.masterId)
        if (f.pid) {
          pid = f.pid
          idx = f.idx
        }
      }
      if (!pid) {
        const f = findMaster((m) => m.sourceTaskId === task.id)
        if (f.pid) {
          pid = f.pid
          idx = f.idx
        }
      }
      let targetPid = pid ?? task.projectId
      if (!targetPid || targetPid === UNCATEGORIZED) return { repeatPids: touched, taskPids }
      // 跨项目迁移：既有模板位于其它项目（编辑时改了所属项目）时，先把模板从旧项目移到目标项目，
      // 使今日任务 / 时间胶囊 / 未来任务三处编辑共用同一套「模板只跟源任务项目走」的语义，
      // 避免旧项目残留模板导致「编辑后仍显示在旧项目 / 重复生成」。
      const destPid = task.projectId && task.projectId !== UNCATEGORIZED ? task.projectId : targetPid
      if (idx >= 0 && pid && destPid !== pid) {
        const oldList = this.repeats[pid] ?? []
        const moving = oldList[idx]
        this.repeats[pid] = oldList.filter((m) => m.id !== moving.id)
        touched.add(pid)
        const destList = this.repeats[destPid] ?? []
        const exist = destList.findIndex((m) => m.id === moving.id || m.sourceTaskId === task.id)
        if (exist >= 0) {
          destList[exist] = { ...moving, projectId: destPid, updatedAt: nowIso() }
          idx = exist
        } else {
          destList.push({ ...moving, projectId: destPid, updatedAt: nowIso() })
          idx = destList.length - 1
        }
        this.repeats[destPid] = destList
        touched.add(destPid)
        pid = destPid
        targetPid = destPid
      }
      const masters = this.repeats[targetPid] ?? []
      if (idx < 0) {
        // 未找到既有模板：
        // - 未来任务编辑（masterId）却找不到模板 → 模板已被删，忽略；
        // - 未完成活跃任务 → 不提前生成（完成时由 _flipComplete 生成）；
        // - 已完成任务（时间胶囊编辑 / 完成态源任务）→ 创建模板（严格 > 今天）
        if (opts?.masterId) return { repeatPids: touched, taskPids }
        if (task.status !== 'completed') return { repeatPids: touched, taskPids }
        const occ = buildRepeatOccurrence(task, today)
        if (!occ) return { repeatPids: touched, taskPids }
        const now = nowIso()
        const newMaster: RepeatMaster = {
          id: task.id,
          projectId: targetPid,
          sourceTaskId: task.id,
          rootTaskId: rootIdOf(task),
          dueDate: occ.dueDate,
          template: occ.template,
          createdAt: now,
          updatedAt: now,
        }
        // 若存在同 id 墓碑（规则曾被删除），原地复活它，避免同 id 墓碑+存活两条并存
        const tombIdx = masters.findIndex((m) => m.id === newMaster.id && m.deletedAt)
        this.repeats[targetPid] =
          tombIdx >= 0
            ? [...masters.slice(0, tombIdx), newMaster, ...masters.slice(tombIdx + 1)]
            : [...masters, newMaster]
        touched.add(targetPid)
        return { repeatPids: touched, taskPids }
      }
      const master = masters[idx]
      const oldRule = master.template.repeat
      if (oldRule && repeatShapeEquals(oldRule, rule)) {
        // 规则形状未变：保留模板 dueDate / 相位，仅按新内容重建模板（沿用原 template.id 稳定 id）
        // 若既有 dueDate 已被单日处理（提前完成/入舱），推进到下一个未处理重复日，
        // 避免重建后的模板再次把自己过滤掉（未来任务区 / 日历图看不到下一次）。
        let dueDate = master.dueDate
        if (task.repeatProcessed?.[dueDate]) {
          const advanced = skipProcessedRepeatDays(rule, dueDate, task.repeatProcessed)
          if (!advanced || (rule.endAfter && advanced > rule.endAfter)) {
            // 剩余重复日全部已处理或已过结束日：写墓碑，链条自然结束（R4 防复活）
            const t = this._tombstoneMasters((m) => m.id === master.id)
            for (const p of t) touched.add(p)
            return { repeatPids: touched, taskPids }
          }
          dueDate = advanced
        }
        const anchor =
          task.reminderTime || task.endTime || task.startTime
            ? dateKeyOf(task.reminderTime || task.endTime || task.startTime)
            : (rule.start ?? dueDate)
        const occ = buildOccurrenceTemplate(task, rule, anchor, dueDate)
        // 沿用原 template.id 稳定 id：新数据为确定性派生 id，跨端重建/物化收敛为同一条
        const templateId = master.template.id
        const rebuilt = { ...occ.template, id: templateId }
        const next = [...masters]
        next[idx] = {
          ...master,
          projectId: targetPid,
          dueDate,
          template: rebuilt,
          updatedAt: nowIso(),
        }
        this.repeats[targetPid] = next
        touched.add(targetPid)
        // P1-4：若该模板的出现已被物化为活跃任务（多端竞态：一端编辑模板时另一端已物化），
        // 一并应用新内容，避免「模板新时间 + 活跃任务旧时间」的分歧（重复任务 Bug 变体）
        const actList = this.tasks[targetPid] ?? []
        const actIdx = actList.findIndex((t) => t.id === templateId)
        if (actIdx >= 0) {
          const { status: prevStatus, createdAt: prevCreatedAt } = actList[actIdx]
          this.tasks[targetPid] = [
            ...actList.slice(0, actIdx),
            { ...actList[actIdx], ...rebuilt, status: prevStatus, createdAt: prevCreatedAt, updatedAt: nowIso() },
            ...actList.slice(actIdx + 1),
          ]
          taskPids.add(targetPid)
        }
        return { repeatPids: touched, taskPids }
      }
      // 规则形状变化 / 老模型：按新规则重算「严格 > 今天」的下一次出现
      const occ = buildRepeatOccurrence(task, today)
      if (!occ) {
        // 新规则没有可生成的出现（如结束日期已过）：写墓碑结束链条（R4 防复活）
        const t = this._tombstoneMasters((m) => m.id === master.id)
        for (const p of t) touched.add(p)
        return { repeatPids: touched, taskPids }
      }
      const next = [...masters]
      next[idx] = {
        ...master,
        projectId: targetPid,
        dueDate: occ.dueDate,
        template: occ.template,
        updatedAt: nowIso(),
      }
      this.repeats[targetPid] = next
      touched.add(targetPid)
      return { repeatPids: touched, taskPids }
    },
    _syncReminders() {
      if (syncReminderTimer) window.clearTimeout(syncReminderTimer)
      syncReminderTimer = window.setTimeout(() => {
        void this.syncReminders()
      }, 300)
    },
    async syncReminders() {
      const auth = useAuthStore()
      // 无登录态：不处理（登出流程负责尽力冲刷，若离线标记保留、下次登录补报）
      if (!auth.token || !auth.username) return
      // 未加载任何任务：无法重建 rows，本次跳过但【保留】待报标记——
      // 页面刷新/重启后内存为空，待任务加载完由下一轮轮询补报，避免丢失
      if (!this.hasAny()) return
      const rows: Parameters<typeof api.syncReminders>[0] = []
      // 单个提醒入队：主任务带 repeat 时把规则一并上报（服务器每行只存这一条规则，
      // 发完邮件后自行推进；名称/描述会上传服务器，供提醒邮件展示）。
      const pushReminder = (
        t: Task,
        subtaskId: string,
        name: string,
        description: string,
        startTime: string | null,
        endTime: string | null,
        reminderTime: string | null,
        projectId: string,
      ) => {
        rows.push({
          id: t.id,
          subtaskId,
          name,
          description,
          startTime,
          endTime,
          reminderTime,
          projectId,
          status: 'pending',
          isReminded: false,
          repeatRule: buildReminderPayload(t),
        })
      }
      for (const t of this.all) {
        if (t.status !== 'pending') continue
        if (t.reminderTime) {
          pushReminder(t, '', t.name, t.description, t.startTime || null, t.endTime || null, t.reminderTime, t.projectId)
        }
        for (const s of pendingSubtaskReminders(t)) {
          pushReminder(t, s.id, `${t.name}（子任务：${s.name || '未命名'}）`, s.description || t.description, s.startTime || null, s.endTime || null, s.reminderTime, t.projectId)
        }
      }
      // 重复模板：完成任务后由模板继续承担周期提醒（模板 id 沿用源任务 id，
      // 避免服务器行被替换后旧时间打断推进或重复发信；取消完成/删除任务即删模板，提醒全部停止）
      for (const masters of Object.values(this.repeats)) {
        for (const m of masters) {
          // 墓碑（R4）：规则已删除，绝不继续从旧模板推送提醒
          if (m.deletedAt) continue
          const t = m.template
          // 路径一修复：单日完成/删除的已处理日期可能只写在根任务上（权威），模板上可能滞后；
          // 合并根任务的 repeatProcessed，确保上报给服务端的 processedDates 完整，
          // 服务端推进时才会跳过这些已处理的重复日、不再对它们发提醒。
          const rootId = m.rootTaskId ?? t.repeatRootId ?? m.id
          const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
          const carrier = {
            ...t,
            id: m.id,
            repeatProcessed: root?.repeatProcessed ?? t.repeatProcessed,
          }
          if (t.reminderTime) {
            pushReminder(carrier, '', t.name, t.description, t.startTime || null, t.endTime || null, t.reminderTime, m.projectId)
          }
          for (const s of pendingSubtaskReminders(t)) {
            pushReminder(carrier, s.id, `${t.name}（子任务：${s.name || '未命名'}）`, s.description || t.description, s.startTime || null, s.endTime || null, s.reminderTime, m.projectId)
          }
        }
      }
      // 说明（BUG-33）：projectIds 包含 '' 表示“未分类”已加载，后端据此精确替换其提醒行，
      // 未加载时不会误删；后端 DELETE/INSERT 已做逐项 + 幂等处理，避免 IN ('') 或主键冲突。
      const loadedPids = Object.keys(this.tasks)
      if (!loadedPids.length && !rows.length) {
        await clearReminderSyncPending(auth.username)
        return
      }
      // BUG-1 修复：先落盘"待报"标记，再上报。成功清除标记；失败保留标记，
      // 由 2 秒轮询 / 下次任务变更 / 登出前冲刷自动补报——不再"失败即丢"。
      await markReminderSyncPending(auth.username)
      try {
        await api.syncReminders(rows, loadedPids)
        await clearReminderSyncPending(auth.username)
      } catch (e) {
        console.warn('提醒清单上报失败，已进入待报队列，稍后自动重试', e)
      }
    },
    /** 轮询/登出冲刷入口：有待报标记才补报，避免无谓请求。失败由内部保留标记继续等下一轮。 */
    async flushReminderSyncIfPending() {
      const auth = useAuthStore()
      if (!auth.token || !auth.username) return
      if (await hasReminderSyncPending(auth.username)) {
        await this.syncReminders()
      }
    },
    hasAny(): boolean {
      return Object.keys(this.tasks).length > 0
    },
    /** 进入追平状态：启动同步/全量加载前调用（bootstrap、手动同步、轮询首轮）。幂等。
     *  注意：**不重置 todayOrderLoaded**——今日顺序的权威值由 loadTodayOrder 独立维护。
     *  追平期间若顺序表已就位，对账仍可安全补登记（现在补登记只插入、绝不移动已登记 id）；
     *  若尚未就位（首启/云端未拉到），初始值就是 false，对账自动跳过，不会用半套数据重建整表。 */
    setSyncCatchingUp() {
      this.syncCatchingUp = true
    },
    /** 追平门闩期间被延迟的自动写回落盘：记录项目（去重），由 finalizeSyncCatchUp 收敛 */
    deferWriteback(projectId: string) {
      if (!this.deferredWritebackProjects.includes(projectId)) {
        this.deferredWritebackProjects.push(projectId)
      }
    },
    /** 墓碑仅入内存 + IDB（不排期 OSS 写）：供追平门闩期间的自愈路径使用，追平后由
     *  finalizeSyncCatchUp 统一 flush（防止陈旧数据在追平期间把墓碑写回覆盖远端证据）。 */
    async upsertTombstonesLocalOnly(
      projectId: string,
      tasks: Array<Pick<Task, 'id' | 'updatedAt'>>,
    ) {
      const entries = tasks
        .filter((t) => t && t.id && t.updatedAt)
        .map((t) => ({ id: t.id, updatedAt: t.updatedAt }))
      if (!entries.length) return
      const month = monthOfNow()
      const purged = entries.filter((e) => e.id.startsWith(PURGED_TOMBSTONE_PREFIX))
      const normal = entries.filter((e) => !e.id.startsWith(PURGED_TOMBSTONE_PREFIX))
      this._putShardEntries(projectId, month, normal)
      this._putPurgedEntries(projectId, month, purged)
      await this._persistTombstonesLocal(projectId)
    },
    /** F3 写前队列：标记项目「有已排期、尚未落盘的变更」（_persist 等排期入口调用）。
     *  去重后写 IDB；页面被杀时未完成的保存由下次启动 finalizeSyncCatchUp 重放。 */
    markDirtyPid(projectId: string) {
      const auth = useAuthStore()
      if (!auth.username || typeof window === 'undefined') return
      void loadDirtyPids(auth.username).then(async (pids) => {
        if (pids.includes(projectId)) return
        await saveDirtyPids(auth.username, [...pids, projectId])
      })
    },
    /** F3 写前队列：项目成功落盘后清除脏标记（saveProject/saveTrash/saveRepeats/saveTombstones 成功时调用） */
    clearDirtyPid(projectId: string) {
      const auth = useAuthStore()
      if (!auth.username || typeof window === 'undefined') return
      void loadDirtyPids(auth.username).then(async (pids) => {
        if (!pids.includes(projectId)) return
        await saveDirtyPids(auth.username, pids.filter((p) => p !== projectId))
      })
    },
    /**
     * 追平完成后的统一收敛（F0/F1/F3）：由 useSyncPoll / useSync 在「无积压变更且本轮全部
     * 拉取成功」时调用。此刻数据已与 OSS 对齐，才允许自动写回：
     *  ① 自动归档昨日完成任务（此时本地 updatedAt 可信，不会误移他端已恢复的任务）；
     *  ② 物化到期重复任务（数据可信后的落盘）；
     *  ③ 今日顺序表最终对账（清理死 id + 追加末尾补登记 + 写回）；
     *  ④ 冲刷追平门闩期间被延迟的自动写回（墓碑→回收站→任务→模板；syncProject 延迟写回
     *     force 重跑）；
     *  ⑤ F3：重放上次会话未落盘的排期保存（force 重跑 syncProject，合并语义保证不覆盖远端）。
     * ①~③ 仅在「首次追平」时执行（幂等）；④⑤ 失败项保留，下轮无积压 poll 再次调用重试。
     * 注意：单项持续失败**不**重新拉起门闩——否则单个坏项目会永久禁用今日对账/自动写回；
     * 失败项只留在 deferredWritebackProjects 里由后续轮询反复冲刷，不影响其它功能。
     */
    async finalizeSyncCatchUp() {
      // 追平未完成（数据不完整）且无待收敛项时不动作
      if (!this.syncCatchingUp && !this.deferredWritebackProjects.length) return
      const wasCatchingUp = this.syncCatchingUp
      // 数据已追平：关闭门闩，本函数内所有自动写回才允许执行
      this.syncCatchingUp = false
      if (wasCatchingUp) {
        try {
          await this.sweepCompleted()
        } catch (e) {
          console.warn('追平归档失败（下轮重试）', e)
        }
        try {
          await this.materializeRepeats()
        } catch (e) {
          console.warn('追平物化失败（下轮重试）', e)
        }
        try {
          this.reconcileTodayOrder()
        } catch (e) {
          console.warn('追平今日顺序对账失败（下轮重试）', e)
        }
      }
      // ④ 追平门闩期间被延迟的自动写回：写序「墓碑→回收站→任务→模板」
      //（与单次操作写序一致，避免对端短暂复活）。仅对「内存已加载」的资源落盘：
      // 未加载资源不写，防止空数组覆盖远端。
      const failed: string[] = []
      for (const pid of this.deferredWritebackProjects) {
        try {
          let ok = this.hasTombstoneData(pid) ? await this.saveTombstonesNow(pid) : true
          ok = (this.trash[pid] !== undefined ? await this.saveTrashNow(pid) : true) && ok
          ok = (this.tasks[pid] !== undefined ? await this.saveProjectNow(pid) : true) && ok
          ok = (this.repeats[pid] !== undefined ? await this.saveRepeatsNow(pid) : true) && ok
          // syncProject 被门闩延迟的写回：force 重拉合并后按原条件写回
          await this.syncProject(pid, true)
          if (!ok) failed.push(pid)
        } catch (e) {
          console.warn('追平收敛写回失败（下轮重试）', pid, e)
          failed.push(pid)
        }
      }
      // ⑤ F3：重放上次会话未落盘的排期保存（force 重跑 syncProject：合并语义保证只把
      //    本地更新的内容写回，不会用空/陈旧数据覆盖远端）
      const dirtyPids = await loadDirtyPids(useAuthStore().username)
      for (const pid of dirtyPids) {
        try {
          await this.syncProject(pid, true)
          this.clearDirtyPid(pid)
        } catch (e) {
          console.warn('重放未落盘保存失败（下次启动重试）', pid, e)
          failed.push(pid)
        }
      }
      this.deferredWritebackProjects = failed
    },
    upsert(task: Task) {
      normalizeTask(task)
      const target = task.projectId
      for (const pid of Object.keys(this.tasks)) {
        if (pid === target) continue
        if (this.tasks[pid].some((t) => t.id === task.id)) {
          this.tasks[pid] = this.tasks[pid].filter((t) => t.id !== task.id)
          this._persist(pid)
        }
      }
      const list = this.tasks[target] ?? []
      const idx = list.findIndex((t) => t.id === task.id)
      const isNew = idx < 0
      task.updatedAt = nowIso()
      if (idx >= 0) {
        const before = list[idx]
        // 「改了时间」判定：只看排序链真正用到的两个字段（endTime 不参与排序，改它不归位），
        // 且按分钟归一后比较，避免表单往返抹掉秒/时区后缀导致误判（见 sortTimeKey）
        const timeChanged =
          sortTimeKey(before.startTime) !== sortTimeKey(task.startTime) ||
          sortTimeKey(before.reminderTime) !== sortTimeKey(task.reminderTime)
        // 「重复属性变更」判定：加/去重复规则会改变任务所属区段（普通区 ↔ 重复区），
        // 与改了时间一样需要重新就位（见 sortActiveList 的「普通在前、重复在后」分组）
        const repeatBefore = !!before.repeat
        Object.assign(before, task)
        const repeatChanged = repeatBefore !== !!before.repeat
        if (timeChanged || repeatChanged) {
          // 与新建任务同一套语义：按统一时间链（提醒 > 开始 > 创建）重找落点，忽略已有手动 sort。
          // 先按状态判定所属区段（pending 区在前、其余在后，与 sortActiveList 一致），
          // pending 段内走 repeatAwareInsertIndex（普通任务只跟普通任务比、重复任务保底在
          // 普通任务之后），重复任务即使带早提醒也绝不插到普通任务前面；最后整体重编 sort 序号。
          const baseline = list.slice()
          list.splice(idx, 1)
          const pendingEnd = list.findIndex((t) => t.status !== 'pending')
          const bound = pendingEnd === -1 ? list.length : pendingEnd
          const at =
            before.status === 'pending'
              ? repeatAwareInsertIndex(list, before, bound)
              : timeInsertIndex(list, before, bound, list.length)
          list.splice(at, 0, before)
          this._renumberOrder(target, list, baseline)
          // 今日页/桌面小组件走另一套手动键（todayOrder 下标），同步按同一套落点归位
          this.repositionTodayOrder(before)
        }
      } else {
        // 新建/跨项目移入：不继承旧项目的 sort；落点与编辑归位共用 repeatAwareInsertIndex：
        //  - 普通任务：只看普通任务的时间，落在「最后一条时间不晚于它的普通任务」之后
        //    （重复任务的位置完全不参与——重复任务哪怕时间更早也不影响普通任务的落点）；
        //  - 重复任务（保底）：永远落在所有普通任务之后，再在重复任务之间按时间落点。
        // 其它任务相对顺序保持不变；之后再整体重排 sort 序号，使新顺序在加载/同步合并后依然保持。
        const pendingEnd = list.findIndex((t) => t.status !== 'pending')
        const bound = pendingEnd === -1 ? list.length : pendingEnd
        const at = repeatAwareInsertIndex(list, task, bound)
        // F2：与编辑归位同一套重编逻辑（baseline = 插入前快照）——只对「sort 值变化」的
        // 任务写新值并 bump updatedAt（被新任务推后的任务位置确实变了，需让新排序跨端胜出）；
        // 未受影响任务保持原 sort 值不动，不再整表重写（避免跨端 tie 裁决复活旧 sort）。
        const insertBaseline = list.slice()
        list.splice(at, 0, task)
        this._renumberOrder(target, list, insertBaseline)
        // 新建任务同样按时间在今日视图就位（与编辑归位同一套语义）：把新任务按时间链插入
        // todayOrder 正确位置（今日不可见——如未来日期——的任务不登记）。跨项目移入的任务若
        // 今日可见也一并按时间归位；已登记的只挪位置，未登记的连同当屏可见任务整体落表。
        this.repositionTodayOrder(task)
      }
      // 新建/移入任务已按时间登记进 todayOrder（见上），进今日页直接按登记顺序就位；
      // 用户拖过后手动顺序优先。
      this.tasks[target] = list
      this._persist(target)
      // 编辑源任务后同步重复模板（与时间胶囊 / 未来任务编辑同一套统一逻辑）：
      // 保持后续周期属性一致；移除重复则删除模板（周期提醒随之停止）。
      // 统一方法只改内存并返回触及项目，这里按原行为防抖落盘。
      const { repeatPids: touchedRepeats, taskPids: touchedTasks } = this._syncRepeatMasterForTask(task)
      for (const pid of touchedRepeats) this._persistRepeats(pid)
      // P1-4 联动：模板的出现若已物化为活跃任务，一并防抖落盘
      for (const pid of touchedTasks) this._persist(pid)
      logAudit(isNew ? '新增任务' : '修改任务', safeDetail(`任务ID：${task.id}，项目ID：${target}`))
    },
    /**
     * 按“数组顺序即展示顺序”重编 sort 序号（不落盘、不写审计，由调用方决定）：
     * 仅对「位置发生变化的任务」更新 updatedAt，使本端 sort 在跨设备合并（mergeTasks 按 updatedAt 取新）
     * 时胜出；未移动的任务保持原 updatedAt，避免覆盖其他设备对该任务的内容编辑。
     * baseline 为位次比对基准（缺省取当前内存数组）；就地改动过 ordered 的调用方必须传入改动前的快照。
     */
    _renumberOrder(projectId: string, ordered: Task[], baseline?: Task[]) {
      const prevIndex = new Map((baseline ?? this.tasks[projectId] ?? []).map((t, i) => [t.id, i]))
      const now = nowIso()
      for (let i = 0; i < ordered.length; i++) {
        const t = ordered[i]
        const oldIdx = prevIndex.get(t.id)
        // F2：只对「sort 值确实变化」的任务写入新值——未移动任务保持原 sort 值，
        // 避免编辑/拖拽时整表重写 sort 造成跨端 tie 裁决把旧 sort 复活（顺序错乱）。
        // moved（新任务 / sort 值变化）的任务才 bump updatedAt，让新排序在跨端合并时胜出。
        const moved = oldIdx === undefined || t.sort !== i
        if (t.sort !== i) t.sort = i
        if (moved) t.updatedAt = now
      }
      this.tasks[projectId] = ordered
    },
    /**
     * 拖拽排序：整体替换该项目的任务数组（顺序即展示顺序），重编 sort 序号并落盘。
     */
    setOrder(projectId: string, ordered: Task[]) {
      this._renumberOrder(projectId, ordered)
      this._persist(projectId)
      logAudit('调整任务顺序', safeDetail(`项目ID：${projectId}，共 ${ordered.filter((t) => t.status === 'pending').length} 项`))
    },
    /**
     * 拖拽子任务排序：整体替换某主任务的子任务数组（顺序即展示顺序）。
     * 写入每个子任务的 sort=下标，并仅对「位置发生变化」的子任务更新 updatedAt，
     * 同时刷新主任务 updatedAt，使本端子任务顺序在跨设备合并（mergeTasks 按 updatedAt 取新）时胜出；
     * 未移动的子任务保持原 updatedAt，避免覆盖其他设备对子任务内容的编辑。
     */
    setSubtaskOrder(projectId: string, taskId: string, orderedSubtasks: Subtask[]) {
      const task = (this.tasks[projectId] ?? []).find((t) => t.id === taskId)
      if (!task) return
      const prev = task.subtasks ?? []
      const prevIndex = new Map(prev.map((s, i) => [s.id, i]))
      const now = nowIso()
      let moved = false
      for (let i = 0; i < orderedSubtasks.length; i++) {
        const s = orderedSubtasks[i]
        const oldIdx = prevIndex.get(s.id)
        if (oldIdx === undefined || oldIdx !== i || s.sort !== i) {
          s.updatedAt = now
          moved = true
        }
        s.sort = i
      }
      task.subtasks = orderedSubtasks
      if (moved) task.updatedAt = now
      this._persist(projectId)
      logAudit('调整子任务顺序', safeDetail(`任务ID：${taskId}，项目ID：${projectId}，共 ${orderedSubtasks.length} 项`))
    },
    /**
     * 拖拽成子任务：把任务 sourceId 变成任务 targetId 的子任务（松手即生效）。
     * 校验：source 自身含子任务 / 带重复规则时禁止（toast 提示，返回 false）。
     * 字段规则：source 自身属性（名称/描述/时间/提醒/附件）原样保留，仅「项目归属」继承
     * 目标任务所在项目；完成状态不保留（新子任务 completed=false）。
     * 跨项目时同时持久化新旧两个项目；今日视图同步从 todayOrder 移除 source id
     * （它不再作为顶层任务出现，防残留引用）。
     * viewProjectId（可选）：调用方（项目视图）传入当前所在项目，优先在该项目数组内定位
     * source/target，避免 this.all 跨项目收敛命中错误项目的同名副本（BUG：拖拽子任务后
     * 任务在视图里“消失”）。跨项目视图（今日页）不传，由 helper 按归属一致兜底。
     */
    convertTaskToSubtask(sourceId: string, targetId: string, viewProjectId?: string): boolean {
      const source = findTaskByIdAcrossProjects(this.tasks, sourceId, viewProjectId)
      const target = findTaskByIdAcrossProjects(this.tasks, targetId, viewProjectId)
      if (!source || !target || source.id === target.id) return false
      if ((source.subtasks?.length ?? 0) > 0) {
        useUiStore().toast('该任务含子任务，无法作为子任务', 'error')
        return false
      }
      if (source.repeat) {
        useUiStore().toast('重复任务不支持作为子任务', 'error')
        return false
      }
      const srcPid = source.projectId
      const dstPid = target.projectId
      const now = nowIso()
      // 记录转换前快照（供撤销还原）：原位置/排序/状态/提醒标记/今日顺序
      const srcList = this.tasks[srcPid] ?? []
      const srcIndex = Math.max(0, srcList.findIndex((t) => t.id === sourceId))
      subtaskConversionSnapshot = {
        sourceId,
        targetId,
        srcPid,
        dstPid,
        srcIndex,
        srcSort: source.sort,
        srcStatus: source.status,
        srcIsReminded: source.isReminded,
        todayIndex: this.todayOrder.indexOf(sourceId),
      }
      const sub: Subtask = {
        id: source.id,
        name: source.name,
        description: source.description,
        startTime: source.startTime,
        endTime: source.endTime,
        reminderTime: source.reminderTime,
        completed: false,
        createdAt: source.createdAt,
        updatedAt: now,
        sort: target.subtasks?.length ?? 0,
        attachments: source.attachments ?? [],
      }
      // 从源项目移除 source（跨项目时先写墓碑：A 变成子任务后不再携带 projectId，
      // 源项目残留副本无法被 filterTasksForProject 识别，对端合并会按「只在一侧出现则保留」
      // 把旧副本并回源项目 → 顶层 A 与子任务 A 同时存在（复制）。墓碑确保跨设备合并时剔除。）
      if (srcPid !== dstPid) {
        void this.upsertTombstones(srcPid, [{ id: sourceId, updatedAt: source.updatedAt }])
      }
      this.tasks[srcPid] = (this.tasks[srcPid] ?? []).filter((t) => t.id !== sourceId)
      if (srcPid !== dstPid) this._persist(srcPid)
      // 追加为目标任务的子任务并刷新
      target.subtasks = [...(target.subtasks ?? []), sub]
      target.updatedAt = now
      this._persist(dstPid)
      // 今日视图：source 不再作为顶层任务，从 todayOrder 移除（防残留引用）
      if (this.todayOrder.includes(sourceId)) {
        this.setTodayOrder(this.todayOrder.filter((id) => id !== sourceId), { audit: false })
      }
      // 完成状态不保留：已完成任务转为未完成子任务，回退当日完成统计
      if (source.status === 'completed') void useStatsStore().addDelta(-1, source.id)
      logAudit('设为子任务', safeDetail(`任务ID：${sourceId}，项目ID：${srcPid} → 父任务ID：${targetId}，项目ID：${dstPid}`))
      return true
    },
    /**
     * 撤销「设为子任务」：按转换前快照把被拖任务从父任务子任务中移出、放回原项目/位置，
     * 还原完成状态、今日顺序与当日统计；若期间任务已被改动（如已提升为顶层）则安全失败。
     */
    undoSubtaskConversion(): boolean {
      const snap = subtaskConversionSnapshot
      if (!snap) return false
      subtaskConversionSnapshot = null
      const target = this.all.find((t) => t.id === snap.targetId)
      if (!target) return false
      const subs = target.subtasks ?? []
      const subIdx = subs.findIndex((s) => s.id === snap.sourceId)
      if (subIdx < 0) {
        useUiStore().toast('任务已被改动，无法撤销', 'error')
        return false
      }
      const sub = subs[subIdx]
      const now = nowIso()
      // 1) 从父任务移除该子任务
      target.subtasks = subs.filter((s) => s.id !== snap.sourceId)
      target.updatedAt = now
      // 2) 还原为顶层任务（还原原状态/提醒标记；附件/时间沿用子任务原值）
      const task: Task = {
        id: sub.id,
        name: sub.name,
        description: sub.description,
        startTime: sub.startTime,
        endTime: sub.endTime,
        reminderTime: sub.reminderTime,
        projectId: snap.srcPid,
        status: snap.srcStatus,
        isReminded: snap.srcIsReminded,
        createdAt: sub.createdAt,
        updatedAt: now,
        sort: snap.srcSort ?? snap.srcIndex,
        subtasks: [],
        attachments: sub.attachments ?? [],
      }
      // 3) 按原位置放回源项目列表
      const list = this.tasks[snap.srcPid] ?? []
      const idx = Math.min(snap.srcIndex, list.length)
      const next = [...list]
      next.splice(idx, 0, task)
      this.tasks[snap.srcPid] = next
      this._persist(snap.srcPid)
      if (snap.srcPid !== snap.dstPid) this._persist(snap.dstPid)
      // 跨项目撤销：转换时在源项目写了墓碑，A 已回到源项目活跃列表，移除墓碑避免残留语义混淆
      if (snap.srcPid !== snap.dstPid) {
        void this.removeTombstones(snap.srcPid, [snap.sourceId])
      }
      // 4) 今日视图顺序：转换时已从 todayOrder 移除，撤销后按原位置放回
      if (snap.todayIndex >= 0 && !this.todayOrder.includes(snap.sourceId)) {
        const to = [...this.todayOrder]
        to.splice(Math.min(snap.todayIndex, to.length), 0, snap.sourceId)
        this.setTodayOrder(to, { audit: false })
      }
      // 5) 完成状态回退当日统计（转换时已完成→未完成扣 1，撤销加回）
      if (snap.srcStatus === 'completed') void useStatsStore().addDelta(1, snap.sourceId)
      logAudit('撤销设为子任务', safeDetail(`任务ID：${snap.sourceId}，项目ID：${snap.srcPid} ← 父任务ID：${snap.targetId}`))
      return true
    },
    /**
     * 子任务提升为主任务：把 parentTaskId 下 subId 子任务变成该项目顶层任务（松手即生效）。
     * 归属父任务所在项目（仅「项目」是继承关系）；自身属性（名称/描述/时间/提醒/附件）
     * 原样保留；完成状态不保留（新任务 status='pending'）；落点与新建任务同一套规则
     * （repeatAwareInsertIndex：按统一时间链就位，忽略手动 sort）。
     * viewProjectId（可选）：调用方（项目视图）传入当前所在项目，优先在该项目数组内定位
     * 父任务，避免 this.all 跨项目收敛命中错误项目的同名父任务（BUG：拖拽子任务后
     * 任务在视图里“消失”）。
     */
    promoteSubtaskToTask(parentTaskId: string, subId: string, viewProjectId?: string): boolean {
      const parent = findTaskByIdAcrossProjects(this.tasks, parentTaskId, viewProjectId)
      if (!parent) return false
      const sub = parent.subtasks?.find((s) => s.id === subId)
      if (!sub) return false
      const pid = parent.projectId
      const now = nowIso()
      const task: Task = {
        id: sub.id,
        name: sub.name,
        description: sub.description,
        startTime: sub.startTime,
        endTime: sub.endTime,
        reminderTime: sub.reminderTime,
        projectId: pid,
        status: 'pending',
        isReminded: false,
        createdAt: sub.createdAt,
        updatedAt: now,
        subtasks: [],
        attachments: sub.attachments ?? [],
      }
      // 从父任务移除该子任务
      parent.subtasks = parent.subtasks.filter((s) => s.id !== subId)
      parent.updatedAt = now
      // 落点与「新建任务」同一套规则（repeatAwareInsertIndex）：提升出来的任务按
      // 「普通任务只跟普通任务比时间、重复任务保底在普通任务之后」就位（它是普通任务）。
      const list = this.tasks[pid] ?? []
      const pendingEnd = list.findIndex((t) => t.status !== 'pending')
      const bound = pendingEnd === -1 ? list.length : pendingEnd
      const at = repeatAwareInsertIndex(list, task, bound)
      const baseline = list.slice()
      list.splice(at, 0, task)
      this._renumberOrder(pid, list, baseline)
      this._persist(pid)
      // 今日视图：新任务若今日可见则登记顺序（按时间链归位；不可见时自动跳过）
      this.repositionTodayOrder(task)
      logAudit('提升为主任务', safeDetail(`子任务ID：${subId}，父任务ID：${parentTaskId} → 任务ID：${task.id}，项目ID：${pid}`))
      return true
    },
    /**
     * 保存今日视图的跨项目拖拽顺序（任务 id 全局有序）。
     * 顺序表独立于各项目 tasks.json 单独存储 + CAS + 同步上报，保证换设备后
     * 今日视图的排列与拖拽时完全一致；展示时按「今日可见 + 仍存在」过滤引用。
     */
    setTodayOrder(orderedIds: string[], opts?: { audit?: boolean }) {
      this.todayOrder = [...orderedIds]
      // 人工顺序的「写入时间」：多端 CAS 冲突时按它判定谁更晚（更晚者胜），并随文件一起上传
      this.todayOrderUpdatedAt = nowIso()
      this.todayOrderDirty = true
      // 有内容的人工顺序即视为权威值已就位：即便云端读取失败，用户这次的拖拽也应当
      // 让后续对账基于它工作（对账只插入、不移动，安全）
      this.todayOrderLoaded = true
      void idbPut('kv', todayOrderCacheKey(useAuthStore().username), {
        ids: this.todayOrder,
        updatedAt: this.todayOrderUpdatedAt,
        dirty: true,
      })
      void this.saveTodayOrderNow()
      // 编辑时间触发的自动归位不单独记账，避免每次编辑都刷一条“调整今日任务顺序”
      if (opts?.audit !== false) logAudit('调整今日任务顺序', safeDetail(`共 ${orderedIds.length} 项`))
    },
    /**
     * 编辑时间后的今日页归位（与项目页同一套「忽略手动键」的时间链语义）：
     *  - 任务已登记进 todayOrder：只在该顺序表内部把这个 id 挪到时间落点，
     *    不新增登记、不裁剪历史 id（未在今日显示的历史 id 保持原样）；
     *  - 任务未登记：确实需要把它登记进正确位置，但展示层是「已登记组整组前置」的硬分组
     *    （见 TodayView.sorted），只登记单条会让它直接跳到列表顶部，与“按时间归位”相反；
     *    因此把当屏今日可见任务按当前渲染顺序整体落表（与拖拽 onDragEnd 写整屏 id 的语义一致）。
     * 今日不可见的任务不处理。渲染顺序没有变化时不写盘，避免无意义的 CAS 写与跨端广播。
     */
    repositionTodayOrder(task: Task) {
      // F0：追平门闩——加载/同步期间 this.all 可能不完整，此时基于不完整列表的整屏落表 /
      // 挪位会重排并写回 OSS（覆盖他端手动顺序）；一律推迟到追平后（由最终对账 + 后续
      // 用户编辑的落点兜底）。
      if (this.syncCatchingUp) return
      const today = todayKey()
      if (!isTaskVisibleToday(task, today)) return
      const byId = new Map(this.all.map((t) => [t.id, t]))
      const orderMap = new Map(this.todayOrder.map((id, i) => [id, i]))
      let ids: string[]
      let renderedBefore: string | null = null
      if (orderMap.has(task.id)) {
        ids = this.todayOrder.filter((id) => id !== task.id)
      } else {
        const visible = this.all.filter((t) => isTaskVisibleToday(t, today))
        const registered = visible
          .filter((t) => orderMap.has(t.id))
          .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
        // 未登记的按「普通在前、重复在后」分组（与展示层 sorted 一致），
        // 保证整体落表后重复任务仍排在普通任务之后
        const unregistered = visible.filter((t) => !orderMap.has(t.id)).sort(compareAutoTasks)
        ids = [...registered, ...unregistered].map((t) => t.id)
        renderedBefore = ids.join('|')
        ids = ids.filter((id) => id !== task.id)
      }
      // 与项目页新建/编辑完全同一套落点（repeatAwareInsertIndexForIds）：
      //  - 普通任务：落在「最后一条时间不晚于它的普通任务」之后，重复任务的位置完全不参与；
      //  - 重复任务（保底）：落在所有普通任务之后，再在重复任务之间按时间落点。
      // 只跟「今日可见」的任务比时间（历史/不可见 id 不参与比较），与原有语义一致。
      const lookup = (id: string): Task | undefined => {
        const t = byId.get(id)
        return t && isTaskVisibleToday(t, today) ? t : undefined
      }
      const at = repeatAwareInsertIndexForIds(ids, task, lookup)
      ids.splice(at, 0, task.id)
      if (ids.join('|') === (renderedBefore ?? this.todayOrder.join('|'))) return
      this.setTodayOrder(ids, { audit: false })
    },
    /**
     * 统一对账：让今日顺序表收敛为「当前今日可见的待办任务」（按时间就位，手动顺序保留）。
     * 触发点：今日视图加载 / 跨天定时器 / 物化 / 批量导入 / 完成·删除·恢复之后。
     *  - 前置条件：**今日顺序的权威值必须已就位**（todayOrderLoaded）。冷启动/追平期间
     *    todayOrder 可能只是旧缓存或空表，此时补登记会用「普通在前、重复垫底」的落点
     *    重排一遍，把手动拖到最前的重复任务顶回末尾（实锤 bug：重启后手动位置丢失）。
     *  - 清理：只剔除**已删除/已完成**的 id；「不在内存」的 id 一律保留（项目尚未加载 /
     *    瞬时状态不再被当成死 id），只有连续两次对账都查不到才真正剔除（防膨胀又不误删）。
     *  - 补登记：今日可见但未登记的待办任务，用与新建/编辑完全同一套落点
     *    （repeatAwareInsertIndexForIds）逐条登记；**已登记 id 的相对位置全程不动**。
     *  - 顺序无变化时不写盘，避免无谓的 CAS 写与跨端广播。
     * 追平门闩（syncCatchingUp）开启期间直接跳过，由 finalizeSyncCatchUp 在追平后统一执行。
     */
    reconcileTodayOrder() {
      // F0：追平门闩——加载/同步期间 this.all / todayOrder 可能陈旧或不完整（缓存恢复落后
      // 于 OSS、增量同步逐项目追平中）。此时执行 ① 清理会把「已登记但尚未加载进内存」的
      // 任务误判为死 id 剔除，② 补登记又按时间重插并写回 OSS 覆盖他端手动顺序（实锤 bug：
      // 大郎该吃药了 被时间重排并同步到全端）。追平后由 finalizeSyncCatchUp 统一执行最终对账。
      if (this.syncCatchingUp) return
      // 权威值未就位（loadTodayOrder 尚未成功拿到云端/缓存权威顺序）：不做任何自动补登记，
      // 否则会用半套数据算出的顺序覆盖用户手动拖拽位置。
      if (!this.todayOrderLoaded) return
      const today = todayKey()
      const byId = new Map(this.all.map((t) => [t.id, t]))
      // ① 清理：仅剔除「确定已删除/已完成」的 id。
      //  「不在内存」不再剔除：冷启动/渐进加载/项目被 LRU 逐出时，未加载 ≠ 已删除；
      //  误删会丢掉该任务的手动顺序（下次补登记就按规则排到重复区末尾）。
      const ids = this.todayOrder.filter((id) => {
        const t = byId.get(id)
        if (!t) {
          const misses = (this.todayOrderMisses[id] ?? 0) + 1
          this.todayOrderMisses[id] = misses
          // 连续两次对账都查不到才判定为死 id（单次 miss 视为瞬时未加载，保守保留）
          if (misses < 2) return true
          delete this.todayOrderMisses[id]
          return false
        }
        delete this.todayOrderMisses[id]
        if (t.status === 'deleted' || t.status === 'completed') return false
        return isTaskVisibleToday(t, today)
      })
      // ② 补登记（F0.4）：今日可见但未登记的待办任务，用与新建/编辑完全同一套落点
      // （repeatAwareInsertIndexForIds）逐条登记：
      //  - 普通任务：落在「最后一条时间不晚于它的普通任务」之后——重复任务的位置不参与；
      //  - 重复任务（保底）：落在所有普通任务之后，再在重复任务之间按时间落点。
      // 已登记任务的相对顺序全程不变（拖拽手动顺序优先），只插入新 id。
      const orderSet = new Set(ids)
      const toInsert = this.all
        .filter((t) => t.status === 'pending' && isTaskVisibleToday(t, today) && !orderSet.has(t.id))
        .sort(compareAutoTasks)
      // 只跟「今日可见」的任务比时间（历史/不可见 id 不参与比较），与 repositionTodayOrder 一致
      const lookup = (id: string): Task | undefined => {
        const t = byId.get(id)
        return t && isTaskVisibleToday(t, today) ? t : undefined
      }
      for (const t of toInsert) {
        const at = repeatAwareInsertIndexForIds(ids, t, lookup)
        ids.splice(at, 0, t.id)
      }
      if (ids.join('|') === this.todayOrder.join('|')) return
      this.setTodayOrder(ids, { audit: false })
    },
    /** 立即把今日顺序表落盘 OSS（CAS + 冲突合并：按 updatedAt 更晚者胜；并集补 id，绝不删/挪） */
    async saveTodayOrderNow(): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) {
        // 凭证/会话未就绪（冷启动瞬间、离线解锁前）：不能静默丢，标记 dirty 由轮询/恢复后重试
        this.todayOrderDirty = true
        return false
      }
      try {
        const client = await createOssClient(auth.creds)
        const key = todayOrderFilePath(auth.username)
        const etagKey = todayOrderEtagKey(auth.username)
        let knownEtag = await idbGet<string>('kv', etagKey)
        const byIdCache = () => new Map(this.all.map((t) => [t.id, t]))
        const cacheWrite = async () => {
          await idbPut('kv', todayOrderCacheKey(auth.username), {
            ids: this.todayOrder,
            updatedAt: this.todayOrderUpdatedAt,
            dirty: this.todayOrderDirty,
          })
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await compareAndSwapPut<{ ids: string[]; updatedAt?: string }>(
            client,
            key,
            { ids: this.todayOrder, updatedAt: this.todayOrderUpdatedAt || undefined },
            knownEtag,
          )
          if (result.ok) {
            if (result.etag) await idbPut('kv', etagKey, result.etag)
            // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
            await idbDel('kv', lmKeyOf(etagKey))
            this.todayOrderDirty = false
            await cacheWrite()
            queueSyncChange(auth.username, 'today_order', null)
            return true
          }
          if (result.remote && Array.isArray((result.remote as { ids?: string[] }).ids)) {
            // 多端同时拖拽：按「谁更晚写入」判定基准（updatedAt 更晚者胜，平局按内容指纹确定性裁决），
            // 另一端多出的 id 用与新建/对账同一套落点补入——绝不删除、绝不移动已采纳 id。
            const remoteIds = (result.remote as { ids: string[] }).ids
            const remoteAt = (result.remote as { updatedAt?: string }).updatedAt ?? ''
            // 平局（含老数据双方都没有时间戳）时用 id 串的字典序做确定性裁决，保证多端收敛到同一结果
            const localWins =
              (this.todayOrderUpdatedAt || '') > remoteAt ||
              ((this.todayOrderUpdatedAt || '') === remoteAt &&
                this.todayOrder.join('|') > remoteIds.join('|'))
            if (localWins) {
              // 本地更晚：保留本地基准（并集补入远端多出的 id），刷新 etag 后重试本地上传
              const byIdLocal = byIdCache()
              this.todayOrder = mergeOrderIds(this.todayOrder, remoteIds, (id) => byIdLocal.get(id))
              knownEtag = result.remoteEtag ?? undefined
              continue
            }
            // 远端更晚：采纳远端为基准，本地多出的 id 并集补入，本轮结束（本地不再 dirty）
            const byIdRemote = byIdCache()
            this.todayOrder = mergeOrderIds(remoteIds, this.todayOrder, (id) => byIdRemote.get(id))
            this.todayOrderUpdatedAt = remoteAt
            this.todayOrderDirty = false
            await cacheWrite()
            return true
          }
          knownEtag = undefined
        }
        // 连撞三次仍是远端持续更新：保持 dirty，交给轮询/下次登录自动重试（不再"提示一次就烂尾"）
        this.todayOrderDirty = true
        await cacheWrite()
        useUiStore().toast('保存今日顺序失败：检测到其他设备持续修改，稍后会自动重试', 'error')
        return false
      } catch (e) {
        // 网络/凭证异常同样保持 dirty，由轮询与页面隐藏前的 flush 重试
        this.todayOrderDirty = true
        try {
          await idbPut('kv', todayOrderCacheKey(useAuthStore().username), {
            ids: this.todayOrder,
            updatedAt: this.todayOrderUpdatedAt,
            dirty: true,
          })
        } catch {
          /* 缓存写入失败不阻断错误提示 */
        }
        console.error('保存今日任务顺序到 OSS 失败', e)
        useUiStore().toast(`保存今日顺序失败（稍后自动重试）：${describeOssError(e)}`, 'error')
        return false
      }
    },
    /** 立即把当前顺序落一次缓存并发起上传（页面隐藏/被杀前尽力调用；失败也不抛） */
    async flushTodayOrder(): Promise<void> {
      const auth = useAuthStore()
      if (!auth.username) return
      try {
        await idbPut('kv', todayOrderCacheKey(auth.username), {
          ids: this.todayOrder,
          updatedAt: this.todayOrderUpdatedAt,
          dirty: this.todayOrderDirty,
        })
      } catch {
        /* 缓存写失败忽略 */
      }
      if (this.todayOrderDirty) void this.saveTodayOrderNow()
    },
    toggleComplete(id: string) {
      this._flipComplete(id, true)
    },
    /** 完成任务/取消完成的核心翻转（applyStats=false 时跳过统计，供确认式流程在 OSS 成功后补记） */
    _flipComplete(id: string, applyStats: boolean): boolean {
      const task = this.all.find((t) => t.id === id)
      if (!task) return false
      const completing = task.status !== 'completed'
      if (completing && task.repeat) {
        // 标记完成日：与单日完成路径（_completeOccurrence 写 repeatProcessed[day]='completed'）保持一致。
        // 否则日历图会把已完成当天继续枚举成"未完成"小块（同一天重复显示）；该标记会随模板/后续
        // 物化任务继承，使已完成的过去日不再作为待办出现（模板 / 物化对这一天自动跳过）。
        task.repeatProcessed = { ...(task.repeatProcessed ?? {}), [todayKey()]: 'completed' }
        // 重复任务完成：不立即生成下一次，而是把下一次出现存成模板（等重复当天再显示）。
        // 提醒邮件由服务器按周期规则继续按时发送，即使不打开 App 也会每天提醒；
        // 模板 id 沿用源任务 id，保证服务器提醒行不被打断。
        const occ = buildRepeatOccurrence(task, todayKey())
        if (occ) {
          const masters = this.repeats[task.projectId] ?? []
          // 已存在存活模板则跳过；墓碑（规则曾被删除）不算，允许本次完成重新创建
          if (!masters.some((m) => m.sourceTaskId === task.id && !m.deletedAt)) {
            const now = nowIso()
            const newMaster: RepeatMaster = {
              id: task.id,
              projectId: task.projectId,
              sourceTaskId: task.id,
              rootTaskId: rootIdOf(task),
              dueDate: occ.dueDate,
              template: occ.template,
              createdAt: now,
              updatedAt: now,
            }
            // 若存在同 id 墓碑（规则曾被删除），原地复活它，避免同 id 墓碑+存活两条并存
            const tombIdx = masters.findIndex((m) => m.id === newMaster.id && m.deletedAt)
            this.repeats[task.projectId] =
              tombIdx >= 0
                ? [...masters.slice(0, tombIdx), newMaster, ...masters.slice(tombIdx + 1)]
                : [...masters, newMaster]
            this._persistRepeats(task.projectId)
            logAudit('生成重复任务模板', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}，周期：${task.repeat.type}`))
          }
        }
      } else if (!completing && task.repeat) {
        // 取消完成：删除该任务的重复模板，恢复由任务自己承担提醒；
        // 服务器端同一 task_id 行的推进时间由“服务端时间较新则保留”逻辑兜底，不重复发信。
        // 同时移除完成日标记（此刻 task.updatedAt 仍是完成时间）：否则今日页 / 日历会一直把
        // 这一天当作“已处理”过滤掉，任务恢复待办后反而不显示。
        const doneDay = dateKeyOf(task.updatedAt)
        if (task.repeatProcessed?.[doneDay]) {
          task.repeatProcessed = { ...task.repeatProcessed }
          delete task.repeatProcessed[doneDay]
          if (!Object.keys(task.repeatProcessed).length) task.repeatProcessed = undefined
        }
        this._deleteMasterForTask(task.id)
      }
      task.status = completing ? 'completed' : 'pending'
      const now = nowIso()
      task.updatedAt = now
      // 完成父任务 → 子任务全部标记完成；取消父任务完成 → 子任务全部恢复未完成
      // （父任务完成时子任务视为完成，保持父子状态一致；仅变化时更新时间避免无谓写入）
      for (const s of task.subtasks ?? []) {
        if (s.completed !== completing) {
          s.completed = completing
          s.updatedAt = now
        }
      }
      this._persist(task.projectId)
      if (applyStats) {
        // 累计完成任务统计（存用户 OSS，绝不清零/重算）：完成 +1，取消完成 -1
        useStatsStore().addDelta(completing ? 1 : -1, task.id)
      }
      logAudit(
        completing ? '完成任务' : '取消完成',
        safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}${task.subtasks?.length ? `，自动联动子任务 ${task.subtasks.length} 个` : ''}`),
      )
      return completing
    },
    /** 确认式完成/取消完成：先翻转，立即写盘（重复任务同时写重复模板），OSS 全部成功才返回 true；
     *  失败回滚任务与重复模板并返回 false（统计在成功后补记，避免失败导致计数漂移）。 */
    async toggleCompleteConfirmed(id: string): Promise<boolean> {
      if (toggleSaving.has(id)) return false
      toggleSaving.add(id)
      try {
        const auth = useAuthStore()
        const task = this.all.find((t) => t.id === id)
        if (!task) return false
        const pid = task.projectId
        const tasksSnap = (this.tasks[pid] ?? []).slice()
        const repeatsSnap = (this.repeats[pid] ?? []).slice()
        // 深拷贝受影响任务：_flipComplete 会原地修改任务（状态 + 子任务联动），
        // 浅拷贝数组无法回滚这些原地修改，失败时需用深拷贝恢复原任务。
        // 注意：任务对象是 Vue reactive 代理，structuredClone 会抛 DataCloneError，
        // 必须改用 JSON 深拷贝（Task/Subtask 字段均为 JSON 可序列化数据）。
        const taskSnap = JSON.parse(JSON.stringify(task))
        const completing = this._flipComplete(id, false)
        const okTasks = await this.saveProjectNow(pid)
        const repeatsChanged = !!task.repeat && JSON.stringify(this.repeats[pid]) !== JSON.stringify(repeatsSnap)
        const okRepeats = repeatsChanged ? await this.saveRepeatsNow(pid) : true
        if (okTasks && okRepeats) {
          await useStatsStore().addDelta(completing ? 1 : -1, task.id)
          // 完成/取消完成统一对账：完成后从今日顺序表移除该 id，取消完成后按时间重新登记
          this.reconcileTodayOrder()
          return true
        }
        // 失败回滚：恢复任务与重复模板（内存 + IDB），避免缓存残留未保存的改动
        const rollbackIdx = tasksSnap.findIndex((x) => x.id === id)
        if (rollbackIdx >= 0) tasksSnap[rollbackIdx] = taskSnap
        this.tasks[pid] = tasksSnap
        this.repeats[pid] = repeatsSnap
        await idbPut('tasks', taskCacheKey(auth.username, pid), tasksSnap)
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), repeatsSnap)
        return false
      } finally {
        toggleSaving.delete(id)
      }
    },
    softDelete(id: string, opts?: { keepRepeatMaster?: boolean }) {
      const task = this.all.find((t) => t.id === id)
      if (!task) return
      // 已完成任务删除进回收站：保留完成时间（updatedAt=完成时间），恢复后不误计为当天完成
      if (task.status !== 'completed') {
        task.status = 'deleted'
        task.updatedAt = nowIso()
      }
      this.tasks[task.projectId] = this.tasks[task.projectId].filter((t) => t.id !== id)
      this.trash[task.projectId] = mergeUnique(this.trash[task.projectId] ?? [], [task])
      // 墓碑先落：删除任务必须留下防复活证据（tasks.json 移除后其他设备不会把它并回活跃列表）
      void this.upsertTombstones(task.projectId, [task])
      this._persist(task.projectId)
      this._persistTrash(task.projectId)
      // 删除重复模板：周期提醒随任务删除一并停止（服务器同 task_id 行下次同步即移除）。
      // keepRepeatMaster=true（已完成重复任务入舱）时保留模板：只归档该完成记录，后续未完成出现不受影响
      if (!opts?.keepRepeatMaster) this._deleteMasterForTask(task.id)
      logAudit('删除任务', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}`))
      // 删除后统一对账：把该任务 id 从今日顺序表移除（防死 id 残留）
      this.reconcileTodayOrder()
    },
    restore(id: string, toProjectId?: string) {
      let task: Task | undefined
      let trashPid: string | undefined
      for (const [pid, list] of Object.entries(this.trash)) {
        const found = list.find((t) => t.id === id)
        if (found) {
          task = found
          trashPid = pid
          break
        }
      }
      if (!task) {
        for (const [, list] of Object.entries(this.tasks)) {
          task = list.find((t) => t.id === id && t.status === 'completed')
          if (task) break
        }
      }
      if (!task) return
      // 显式恢复 = 用户要把这条记录找回来：清除它的「永久删除墓碑」。
      // 单日记录的 id 是合成的（同一重复日会再次物化出同一 id），不清会挡住它下次入舱。
      void this.clearPurgedTombstones(trashPid ?? task.projectId, [id])
      // 单日记录（提前完成/入舱生成的 per-day 回收站记录）：恢复时清除根任务/模板上该日的
      // 已处理标记，让该重复日重新作为待办出现；不生成合成 id 的活跃任务
      if (task.repeatOccurrence) {
        const { rootId, date } = task.repeatOccurrence
        const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
        if (root?.repeatProcessed?.[date]) {
          root.repeatProcessed = { ...root.repeatProcessed }
          delete root.repeatProcessed[date]
          if (!Object.keys(root.repeatProcessed).length) root.repeatProcessed = undefined
          root.updatedAt = nowIso()
          if (root.status === 'completed') this._persistTrash(root.projectId, true)
          else this._persist(root.projectId)
        }
        // 同时清除重复模板上该日的标记（模板承载日历未来重复日显示）
        for (const [p, ms] of Object.entries(this.repeats)) {
          const list = ms ?? []
          let changed = false
          const next = list.map((m) => {
            if (m.deletedAt) return m // 墓碑不参与恢复（R4）
            if (m.template.repeatProcessed?.[date] && (m.rootTaskId ?? m.template.repeatRootId ?? m.id) === rootId) {
              const tp = { ...(m.template.repeatProcessed ?? {}) }
              delete tp[date]
              changed = true
              return {
                ...m,
                template: {
                  ...m.template,
                  repeatProcessed: Object.keys(tp).length ? tp : undefined,
                },
                updatedAt: nowIso(),
              }
            }
            return m
          })
          if (changed) {
            this.repeats[p] = next
            this._persistRepeats(p)
          }
        }
        // 从回收站/活跃列表移除该单日记录，不进入活跃列表
        if (trashPid !== undefined) {
          this.trash[trashPid] = (this.trash[trashPid] ?? []).filter((t) => t.id !== id)
          this._persistTrash(trashPid, true)
        } else {
          for (const [pid, list] of Object.entries(this.tasks)) {
            this.tasks[pid] = list.filter((t) => t.id !== id)
            this._persist(pid)
          }
        }
        logAudit('恢复任务', safeDetail(`任务ID：${id}，项目ID：${task.projectId}`))
        return
      }
      const oldPid = task.projectId
      // 已删除项目的任务恢复时重新归属到有效项目，避免成为刷新后不可见的“孤儿”
      if (toProjectId) task.projectId = toProjectId
      const completing = task.status === 'completed'
      task.status = completing ? 'completed' : 'pending'
      // 已完成任务恢复：保留完成时间（updatedAt），避免恢复后误计为当天完成；仅待办恢复才刷新
      if (!completing) task.updatedAt = nowIso()
      if (trashPid !== undefined) {
        // 无论目标项目改到哪里，都必须从它原本所在的 trash 键中移除
        const sourcePid = trashPid
        this.trash[sourcePid] = (this.trash[sourcePid] ?? []).filter((t) => t.id !== id)
        const pid = task.projectId
        if (pid !== sourcePid) {
          this.tasks[sourcePid] = (this.tasks[sourcePid] ?? []).filter((t) => t.id !== id)
          this._persist(sourcePid)
        }
        this.tasks[pid] = sortActiveList(mergeUnique(this.tasks[pid] ?? [], [task]))
        // 恢复任务：从墓碑日志移除对应条目（整文件替换语义，删除会传播到其他设备）
        void this.removeTombstones(sourcePid, [id])
        this._persistTrash(sourcePid)
        this._persist(pid)
      } else {
        // 任务来自当前 active（当天完成的 completed）
        if (oldPid !== task.projectId) {
          this.tasks[oldPid] = (this.tasks[oldPid] ?? []).filter((t) => t.id !== id)
          this._persist(oldPid)
        }
        const pid = task.projectId
        this.tasks[pid] = sortActiveList(this.tasks[pid] ?? [])
        this._persist(pid)
      }
      // 恢复重复任务：待办恢复后由任务自己承担后续周期，删除其重复模板避免与模板重复生成/重复提醒；
      // 已完成恢复（历史完成记录）保留重复模板，后续未完成出现继续保留（入舱/恢复都不打断重复链）
      if (!completing) this._deleteMasterForTask(task.id)
      logAudit('恢复任务', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}`))
      // 恢复后统一对账：恢复的待办若今日可见，按时间重新登记进今日顺序表
      this.reconcileTodayOrder()
    },
    /** 批量新增任务（Markdown 导入用）：整批合并落盘，避免逐条防抖写 OSS */
    bulkAdd(list: Task[]) {
      const now = nowIso()
      const touched = new Set<string>()
      for (const t of list) {
        normalizeTask(t)
        if (!t.createdAt) t.createdAt = now
        t.updatedAt = now
        const target = t.projectId
        if (!this.tasks[target]) this.tasks[target] = []
        if (this.tasks[target].some((x) => x.id === t.id)) continue
        this.tasks[target].push(t)
        touched.add(target)
      }
      for (const pid of touched) {
        this.tasks[pid] = sortActiveList(this.tasks[pid])
        this._persist(pid)
      }
      // 批量导入的今日可见任务由 reconcileTodayOrder 统一按时间登记进 todayOrder；
      // 未来日期导入任务在首次成为今日可见时（跨天对账）自动登记。
      this.reconcileTodayOrder()
      logAudit('批量导入任务', safeDetail(`共导入 ${list.length} 个任务（涉及 ${touched.size} 个项目）`))
    },
    /** 切换子任务完成状态 */
    toggleSubtask(taskId: string, subId: string) {
      const task = this.all.find((t) => t.id === taskId)
      if (!task) return
      const sub = task.subtasks.find((s) => s.id === subId)
      if (!sub) return
      sub.completed = !sub.completed
      const now = nowIso()
      sub.updatedAt = now
      task.updatedAt = now
      // 一致性联动：父任务已完成时取消子任务勾选 → 父任务一并改回未完成；
      // 其它子任务保持原状（仅当前子任务回到未完成，父任务恢复待办）
      if (!sub.completed && task.status === 'completed') {
        task.status = 'pending'
        task.updatedAt = now
        // 取消完成重复任务：删除其重复模板，恢复由任务自己承担后续周期（与 _flipComplete 取消完成一致）
        if (task.repeat) this._deleteMasterForTask(task.id)
        // 累计完成统计回退 -1（父任务由完成改为未完成）
        void useStatsStore().addDelta(-1, task.id)
        logAudit('取消完成', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}，由取消子任务勾选联动`))
      }
      this._persist(task.projectId)
      logAudit(sub.completed ? '完成子任务' : '取消完成子任务', safeDetail(`子任务ID：${sub.id}，所属任务ID：${task.id}`))
    },
    /** 给指定主任务新增一个空子任务（卡片「＋ 子任务」按钮） */
    addSubtaskTo(taskId: string) {
      const task = this.all.find((t) => t.id === taskId)
      if (!task) return
      task.subtasks.push(newSubtask())
      task.updatedAt = nowIso()
      this._persist(task.projectId)
    },
    /** 删除指定子任务（卡片展开区内联编辑） */
    removeSubtaskFrom(taskId: string, subId: string) {
      const task = this.all.find((t) => t.id === taskId)
      if (!task) return
      const sub = task.subtasks.find((s) => s.id === subId)
      task.subtasks = task.subtasks.filter((s) => s.id !== subId)
      task.updatedAt = nowIso()
      this._persist(task.projectId)
      // 同时清理该子任务在用户 OSS 中的附件二进制
      const auth = useAuthStore()
      if (auth.creds && sub?.attachments?.length) void deleteAttachments(auth.creds, sub.attachments)
      // 附件删除审计日志（统一行为名「删除附件」，来源=删除子任务）
      if (sub?.attachments?.length) {
        logAttachmentDeletion({
          source: '删除子任务',
          count: sub.attachments.length,
          orphanCount: 0,
          totalSize: sub.attachments.reduce((s, a) => s + (a.size || 0), 0),
          files: sub.attachments.map((a) => ({ name: ossFileName(a.key) || a.name, taskName: task.name })),
        })
      }
      logAudit('删除子任务', safeDetail(`子任务ID：${sub?.id || '未知'}，所属任务ID：${task.id}`))
    },
    /** 子任务字段内联编辑后触发落盘（防抖统一在 _persist 内）。
     *  opts 用于区分“新增子任务/修改子任务”并带上日志详情。 */
    touchTask(taskId: string, opts?: { action?: string; detail?: string }) {
      const task = this.all.find((t) => t.id === taskId)
      if (!task) return
      task.updatedAt = nowIso()
      this._persist(task.projectId)
      logAudit(opts?.action || '修改任务', opts?.detail || safeDetail(`任务ID：${task.id}`))
    },
    permanentDelete(projectId: string, id: string) {
      const target =
        (this.tasks[projectId] ?? []).find((t) => t.id === id) ??
        (this.trash[projectId] ?? []).find((t) => t.id === id)
      // 永久删除的防复活证据（落盘顺序见 permanentDeleteConfirmed：墓碑必须先于 tasks/trash）：
      //  · 真实 id 墓碑：其它端的「活跃列表」合并据此剔除（当天完成未归档的任务否则会被并回）；
      //    updatedAt 必须沿用任务的 updatedAt，applyDeletedTombstones 靠它判断「谁更新」；
      //  · purged:<id> 墓碑：其它端的「回收站分片」合并据此剔除（否则并集合并 + 本地缓存写回）；
      //    updatedAt 用「此刻」——永久删除的生效时间，否则老记录（updatedAt 在裁剪窗口外）的标记
      //    会被 pruneTombstones 立刻裁掉，防复活失效。
      if (target) {
        void this.upsertTombstones(projectId, [target])
        void this.upsertTombstones(projectId, [{ id: purgedTombstoneId(target.id), updatedAt: nowIso() }])
      }
      // 永久删除单日记录：清除根任务/模板上该日的已处理标记，该重复日重新作为待办出现
      if (target?.repeatOccurrence) {
        const { rootId, date } = target.repeatOccurrence
        const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
        if (root?.repeatProcessed?.[date]) {
          root.repeatProcessed = { ...root.repeatProcessed }
          delete root.repeatProcessed[date]
          if (!Object.keys(root.repeatProcessed).length) root.repeatProcessed = undefined
          root.updatedAt = nowIso()
          if (root.status === 'completed') this._persistTrash(root.projectId, true)
          else this._persist(root.projectId)
        }
        for (const [p, ms] of Object.entries(this.repeats)) {
          const list = ms ?? []
          let changed = false
          const next = list.map((m) => {
            if (m.deletedAt) return m // 墓碑不参与恢复（R4）
            if (m.template.repeatProcessed?.[date] && (m.rootTaskId ?? m.template.repeatRootId ?? m.id) === rootId) {
              const tp = { ...(m.template.repeatProcessed ?? {}) }
              delete tp[date]
              changed = true
              return {
                ...m,
                template: {
                  ...m.template,
                  repeatProcessed: Object.keys(tp).length ? tp : undefined,
                },
                updatedAt: nowIso(),
              }
            }
            return m
          })
          if (changed) {
            this.repeats[p] = next
            this._persistRepeats(p)
          }
        }
      }
      this.tasks[projectId] = (this.tasks[projectId] ?? []).filter((t) => t.id !== id)
      this.trash[projectId] = (this.trash[projectId] ?? []).filter((t) => t.id !== id)
      this._persist(projectId)
      this._persistTrash(projectId)
      // 永久删除同样清除重复模板，周期提醒全部停止
      this._deleteMasterForTask(id)
      // 同时清理该任务及其子任务在用户 OSS 中的附件二进制
      if (target) {
        const auth = useAuthStore()
        const atts = [
          ...(target.attachments ?? []),
          ...(target.subtasks ?? []).flatMap((sub) => sub.attachments ?? []),
        ]
        if (auth.creds && atts.length) void deleteAttachments(auth.creds, atts)
        // 附件删除审计日志（统一行为名「删除附件」，来源=永久删除任务）
        if (atts.length) {
          logAttachmentDeletion({
            source: '永久删除任务',
            count: atts.length,
            orphanCount: 0,
            totalSize: atts.reduce((s, a) => s + (a.size || 0), 0),
            files: atts.map((a) => ({ name: ossFileName(a.key) || a.name, taskName: target.name })),
          })
        }
      }
      logAudit('永久删除任务', safeDetail(`任务ID：${id}，项目ID：${projectId}`))
    },
    /** 项目删除：全部任务（含已有回收站）并入 trash 保留，活跃列表清空 */
    markAllDeleted(projectId: string) {
      const active = this.tasks[projectId] ?? []
      // 已完成任务整项目删除：保留完成时间（updatedAt），恢复项目时不误计为当天完成；仅未完成转 deleted 才刷新
      const moved = active.map((t) =>
        t.status === 'completed'
          ? { ...t, status: 'completed' as const }
          : { ...t, status: 'deleted' as const, updatedAt: nowIso() },
      )
      this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], moved)
      this.tasks[projectId] = []
      // 墓碑先落：整项目删除为所有任务写防复活证据（项目恢复时再按恢复任务移除对应墓碑）
      void this.upsertTombstones(projectId, moved)
      // 项目归档进回收站：其重复模板一并标记墓碑，周期提醒停止（恢复项目时任务重新承担；
      // R4：写墓碑而非直接清空，避免离线端把已归档项目的旧规则并集写回复活）
      const t = this._tombstoneMasters((m) => m.projectId === projectId)
      for (const p of t) this._persistRepeats(p)
      this._persist(projectId)
      this._persistTrash(projectId)
    },
    /** 整项目恢复：未完成任务还原为活跃待办；今天完成的回到活跃“已完成”；历史完成的留在回收站/时间胶囊
     *  （三者的完成时间 updatedAt 一律保留，恢复后不会误计为“今天完成”）。
     *  回收站分片只保留归档记录，删除其余分片文件（含旧版 trash.json），使项目从“已删除项目”扫描结果中消失 */
    async restoreProjectTasks(projectId: string) {
      const deleted = this.trash[projectId] ?? []
      // 先删物理分片（含未加载的旧月份），再清内存，避免刷新后旧分片残留
      await this.purgeTrashFiles(projectId)
      if (deleted.length) {
        const today = todayKey()
        // 分流恢复，避免历史完成的任务被误计为“今天完成”：
        // - 未完成（deleted）→ 待办，刷新 updatedAt；
        // - 今天完成的 → 回到活跃“已完成”，保留完成时间（updatedAt）；
        // - 历史完成的 → 留在回收站/时间胶囊（保留完成时间，恢复后立即按原日期归档，不污染今日统计）
        const restored: Task[] = []
        const archived: Task[] = []
        for (const t of deleted) {
          if (t.status === 'completed') {
            if (dateKeyOf(t.updatedAt) === today) restored.push({ ...t, status: 'completed' as const })
            else archived.push({ ...t, status: 'completed' as const })
          } else {
            restored.push({ ...t, status: 'pending' as const, updatedAt: nowIso() })
          }
        }
        // 恢复的重复任务由任务自己承担后续周期：把其重复模板标记墓碑，避免与模板重复生成/重复提醒
        //（R4：写墓碑而非直接移除，防止离线端把已删除规则并集写回）
        const ids = new Set(deleted.map((t) => t.id))
        const t = this._tombstoneMasters((m) => ids.has(m.sourceTaskId))
        for (const p of t) this._persistRepeats(p)
        this.tasks[projectId] = sortActiveList(mergeUnique(this.tasks[projectId] ?? [], restored))
        // purgeTrashFiles 已清空内存回收站：这里只写回“历史完成”的归档记录
        this.trash[projectId] = archived
        // 恢复的任务（待办 + 今天完成）从墓碑日志移除：恢复后不应再被墓碑压掉；
        // 历史完成记录留在胶囊，其墓碑保留（防复活证据不随恢复丢失）
        if (restored.length) {
          await this.removeTombstones(projectId, restored.map((x) => x.id))
          // 显式恢复整项目 = 用户要把这些任务找回来：一并清除永久删除墓碑（否则它们会被写盘过滤剔除）
          await this.clearPurgedTombstones(projectId, restored.map((x) => x.id))
        }
        this._persist(projectId)
        this._persistTrash(projectId, true)
      }
    },
    /** 重名合并：把已删除项目的活跃+回收站任务并入同名现有项目（未完成/今天完成的回收站任务还原为活跃，
     *  历史完成的保留在目标项目回收站/时间胶囊），并删除旧项目全部回收站分片文件 */
    async mergeProjectInto(fromId: string, toId: string) {
      const active = (this.tasks[fromId] ?? []).map((t) => ({ ...t, projectId: toId }))
      // 与恢复项目同规则分流：未完成 → 待办（刷新 updatedAt）；今天完成的 → 活跃“已完成”（保留完成时间）；
      // 历史完成的 → 目标项目回收站/时间胶囊（保留完成时间，避免误计为当天完成）
      const today = todayKey()
      const restored: Task[] = []
      const archived: Task[] = []
      for (const t of this.trash[fromId] ?? []) {
        const base = { ...t, projectId: toId }
        if (t.status === 'completed') {
          if (dateKeyOf(t.updatedAt) === today) restored.push({ ...base, status: 'completed' as const })
          else archived.push({ ...base, status: 'completed' as const })
        } else {
          restored.push({ ...base, status: 'pending' as const, updatedAt: nowIso() })
        }
      }
      this.tasks[toId] = sortActiveList(mergeUnique(this.tasks[toId] ?? [], [...active, ...restored]))
      this.tasks[fromId] = []
      this.trash[fromId] = []
      this.trash[toId] = mergeUnique(this.trash[toId] ?? [], archived)
      // 恢复/迁移到目标项目的任务（待办 + 今天完成）从墓碑日志移除（源/目标项目都清）：
      // 历史完成记录保留在目标项目胶囊，其墓碑保留（防复活证据不随合并丢失）
      const movedBack = [...active, ...restored].map((t) => t.id)
      if (movedBack.length) {
        await this.removeTombstones(fromId, movedBack)
        await this.removeTombstones(toId, movedBack)
        // 显式恢复/合并 = 用户要把这些任务找回来：一并清除永久删除墓碑（否则写盘过滤会剔除它们）
        await this.clearPurgedTombstones(toId, movedBack)
      }
      await this.purgeTrashFiles(fromId)
      // 重名合并：重复模板随项目一并合并到目标项目；fromId 侧写墓碑（R4：防离线端
      // 把已合并项目的旧规则并集写回 fromId 文件复活）
      const fromMasters = this.repeats[fromId] ?? []
      if (fromMasters.length) {
        this.repeats[toId] = [
          ...(this.repeats[toId] ?? []),
          ...fromMasters.map((m) => ({ ...m, projectId: toId })),
        ]
        this._persistRepeats(toId)
      }
      const tomb = this._tombstoneMasters((m) => m.projectId === fromId)
      for (const p of tomb) this._persistRepeats(p)
      this._persist(toId)
      this._persist(fromId)
      this._persistTrash(fromId)
      if (archived.length) this._persistTrash(toId, true)
    },
    /**
     * 确认式保存任务：先并入内存，立即写入 OSS，全部成功才返回 true（调用方据此弹成功提示）；
     * 失败时回滚内存与 IDB 到保存前状态并返回 false，避免“提示失败但内存已改”。
     * 跨项目移动会同时保存新旧两个项目文件。
     * 注意：跨项目移动前必须先把涉及的新旧项目都加载进内存，否则——
     *   1) 目标项目未加载时会把其 OSS 文件覆盖成只剩这一条任务（丢失该项目其他任务）；
     *   2) 源项目未加载时不会从源文件移除该任务，导致“目标项目多了一条、源项目没删”。
     */
    async saveTaskConfirmed(task: Task, opts?: { prevProjectId?: string }): Promise<boolean> {
      const auth = useAuthStore()
      // 涉及的项目 = 新项目 + 显式传入的旧项目 + 内存中能找到该任务的所有已加载项目
      const touchPids = new Set<string>([task.projectId])
      if (opts?.prevProjectId) touchPids.add(opts.prevProjectId)
      for (const [pid, list] of Object.entries(this.tasks)) {
        if (list.some((t) => t.id === task.id)) touchPids.add(pid)
      }
      // 确保涉及的项目都已加载（源项目在正常编辑流中必然已加载，这里对未加载的目标/源项目兜底）
      for (const pid of touchPids) {
        if (!this.loadedProjects.includes(pid)) await this.loadProject(pid)
      }
      const tasksSnap = new Map<string, Task[]>()
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      const repeatsBefore = new Map<string, string>()
      // 重复模板可能受影响的项目 = 本次保存涉及的项目 + 内存里已加载模板的所有项目
      // （跨项目迁移 / 移除重复时会清掉旧项目里的同源模板），全部快照以便确认式落盘与失败回滚
      const repeatsCandidates = new Set<string>([...touchPids, ...Object.keys(this.repeats)])
      for (const pid of touchPids) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
      }
      for (const pid of repeatsCandidates) {
        repeatsSnap.set(pid, (this.repeats[pid] ?? []).slice())
        repeatsBefore.set(pid, JSON.stringify(this.repeats[pid] ?? []))
      }
      this.upsert(task)
      const okTasks = (await Promise.all([...touchPids].map((pid) => this.saveProjectNow(pid)))).every(Boolean)
      // 编辑重复任务 / 移除重复 / 新生成模板都会改 repeats：按确认式立即落盘，成功才返回 true
      const changedRepeats = [...repeatsBefore.keys()].filter(
        (pid) => JSON.stringify(this.repeats[pid] ?? []) !== repeatsBefore.get(pid),
      )
      const okRepeats = (await Promise.all(changedRepeats.map((pid) => this.saveRepeatsNow(pid)))).every(Boolean)
      if (okTasks && okRepeats) return true
      // 失败回滚：恢复内存 + IDB，并尽力把已写入 OSS 的文件还原为保存前快照，
      // 避免“目标项目多了一条、源项目没删”的脏数据残留在远端（半成功写入无法靠内存回滚撤销）
      for (const [pid, list] of tasksSnap) {
        this.tasks[pid] = list
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
        await this.saveProjectNow(pid, list)
      }
      for (const [pid, list] of repeatsSnap) {
        this.repeats[pid] = list
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), list)
        await this.saveRepeats(pid, list).catch(() => {})
      }
      return false
    },
    /** 确认式保存子任务：应用到父任务后立即写入 OSS；失败时回滚并返回 false */
    async saveSubtaskConfirmed(
      parentTaskId: string,
      sub: Subtask,
      opts?: { action?: string; detail?: string },
    ): Promise<boolean> {
      const auth = useAuthStore()
      const task = this.all.find((t) => t.id === parentTaskId)
      if (!task) return false
      const pid = task.projectId
      const tasksSnap = (this.tasks[pid] ?? []).slice()
      const idx = task.subtasks.findIndex((s) => s.id === sub.id)
      const isNewSub = idx < 0
      if (idx >= 0) task.subtasks[idx] = sub
      else task.subtasks.push(sub)
      this.touchTask(parentTaskId, {
        action: opts?.action ?? (isNewSub ? '新增子任务' : '修改子任务'),
        detail: opts?.detail ?? safeDetail(`子任务ID：${sub.id}，所属任务ID：${parentTaskId}`),
      })
      const ok = await this.saveProjectNow(pid)
      if (ok) return true
      this.tasks[pid] = tasksSnap
      await idbPut('tasks', taskCacheKey(auth.username, pid), tasksSnap)
      return false
    },
    /** 后台附件队列专用：把「保存任务时还在上传」的附件写回任务/子任务并落盘。
     *  任务已被删除/子任务不存在/落盘失败返回 false，由队列清理孤文件。 */
    async attachBackgroundAttachment(
      targetTaskId: string,
      subtaskId: string | null,
      meta: AttachmentMeta,
      projectId: string,
    ): Promise<boolean> {
      if (!this.loadedProjects.includes(projectId)) await this.loadProject(projectId)
      const task = (this.tasks[projectId] ?? []).find((t) => t.id === targetTaskId)
      if (task) {
        if (subtaskId) {
          const sub = task.subtasks.find((s) => s.id === subtaskId)
          if (!sub) return false
          if (!sub.attachments.some((a) => a.id === meta.id)) sub.attachments.push(meta)
        } else if (!task.attachments.some((a) => a.id === meta.id)) {
          task.attachments.push(meta)
        }
        task.updatedAt = nowIso()
        return this.saveProjectNow(projectId)
      }
      // 时间胶囊任务（不在活跃列表，也不在 repeats 模板）：
      // 后台上传完成的附件写回胶囊并落盘；保留完成/入舱时间，不刷新 updatedAt
      const trashTask = (this.trash[projectId] ?? []).find((t) => t.id === targetTaskId)
      if (trashTask) {
        if (subtaskId) {
          const sub = trashTask.subtasks.find((s) => s.id === subtaskId)
          if (!sub) return false
          if (!sub.attachments.some((a) => a.id === meta.id)) sub.attachments.push(meta)
        } else if (!trashTask.attachments.some((a) => a.id === meta.id)) {
          trashTask.attachments.push(meta)
        }
        return this.saveTrashNow(projectId)
      }
      // 未来任务的重复出现（repeats 中的模板）不在主任务列表：
      // 把后台上传完成的附件写回模板并持久化 repeats，保证“像普通任务一样编辑未来任务”时附件不丢
      const masters = this.repeats[projectId] ?? []
      const master = masters.find((m) => !m.deletedAt && m.template.id === targetTaskId)
      if (!master) return false
      const template = master.template
      if (subtaskId) {
        const sub = template.subtasks.find((s) => s.id === subtaskId)
        if (!sub) return false
        if (!sub.attachments.some((a) => a.id === meta.id)) sub.attachments.push(meta)
      } else if (!template.attachments.some((a) => a.id === meta.id)) {
        template.attachments.push(meta)
      }
      template.updatedAt = nowIso()
      return this.saveRepeatsNow(projectId)
    },
    /** 确认式移入回收站：立即写盘任务+回收站，成功才返回 true；失败回滚并返回 false。
     *  墓碑写盘结果计入成功判定：墓碑是唯一跨设备防复活证据（日常同步已不再读回收站分片），
     *  若写盘失败却静默返回成功，其它设备会把已删任务并集写回复活、本端重启后任务也会回来。 */
    async softDeleteConfirmed(id: string, opts?: { keepRepeatMaster?: boolean }): Promise<boolean> {
      const auth = useAuthStore()
      const task = this.all.find((t) => t.id === id)
      if (!task) return false
      const pid = task.projectId
      const tasksSnap = (this.tasks[pid] ?? []).slice()
      const trashSnap = (this.trash[pid] ?? []).slice()
      const tombstonesSnap = this.snapshotTombstones(pid)
      this.softDelete(id, opts)
      // 墓碑先落：确认式删除必须让墓碑日志先于 tasks.json 写盘，
      // 否则另一台设备在「tasks 已删、墓碑未写」窗口内轮询会复活该任务（写顺序约束）。
      // 墓碑写盘失败 ⇒ 删除证据未上云：此时 tasks/trash 尚未写盘，直接回滚内存 + IDB 并明确
      // 报错，杜绝「任务消失但没真正入舱 / 其它设备复活 / 重启又回来」的静默不一致。
      const okTombstone = await this.saveTombstonesNow(pid)
      if (!okTombstone) {
        this.tasks[pid] = tasksSnap
        this.trash[pid] = trashSnap
        await this.restoreTombstones(pid, tombstonesSnap)
        await idbPut('tasks', taskCacheKey(auth.username, pid), tasksSnap)
        await idbPut('trash', trashCacheKey(auth.username, pid), trashSnap)
        useUiStore().toast('存入时间胶囊失败：删除记录同步未完成，请重试', 'error')
        return false
      }
      const [okTasks, okTrash] = await Promise.all([this.saveProjectNow(pid), this.saveTrashNow(pid)])
      if (okTasks && okTrash) return true
      // 失败回滚：恢复内存 + IDB；墓碑已上云，须把 OSS 墓碑还原为保存前快照，
      // 并尽力把已写入 OSS 的 tasks/trash 还原为快照，避免半成功写入残留为跨端脏数据
      this.tasks[pid] = tasksSnap
      this.trash[pid] = trashSnap
      await this.restoreTombstones(pid, tombstonesSnap)
      await idbPut('tasks', taskCacheKey(auth.username, pid), tasksSnap)
      await idbPut('trash', trashCacheKey(auth.username, pid), trashSnap)
      await this.saveTombstonesNow(pid)
      if (okTasks) await this.saveProjectNow(pid, tasksSnap).catch(() => {})
      if (okTrash) await this.saveTrashNow(pid, trashSnap).catch(() => {})
      return false
    },

    /**
     * 确认式保存“未来任务”中的重复出现（模板编辑）：
     * - 保留重复规则：统一走 _syncRepeatMasterForTask（与今日任务 / 时间胶囊编辑同一套逻辑），
     *   只更新 repeats 中的模板内容并重算下一次出现，不落入主任务列表；
     *   今天的已完成源任务保持完成，绝不额外生成「今天」的新任务；
     * - 移除重复规则：删除模板，把本次出现转为普通一次性任务（upsert 到主列表）；
     * 立即写盘，全部成功才返回 true，失败回滚内存与 IDB 并返回 false。
     */
    async saveFutureOccurrenceConfirmed(task: Task, masterId: string): Promise<boolean> {
      const auth = useAuthStore()
      // 模板始终留在其原项目下（跨项目移动重复未来出现属于低频场景，忽略项目切换以避免数据不一致）
      let pid: string | undefined
      for (const k of Object.keys(this.repeats)) {
        if ((this.repeats[k] ?? []).some((m) => m.id === masterId)) {
          pid = k
          break
        }
      }
      if (!pid) return false
      task.projectId = pid
      const tasksSnap = (this.tasks[pid] ?? []).slice()
      const repeatsSnap = (this.repeats[pid] ?? []).slice()
      const masters = this.repeats[pid] ?? []
      const idx = masters.findIndex((m) => m.id === masterId)
      if (idx < 0) return false
      normalizeTask(task)
      task.updatedAt = nowIso()
      // P1-4 联动可能改到活跃任务（多端竞态下模板的出现已被物化）：记录后统一落盘
      const touchedTasks = new Set<string>()
      if (!task.repeat) {
        // 移除重复：标记模板墓碑，本次出现转为普通一次性任务（R4：防并集写回复活）
        const t = this._tombstoneMasters((m) => m.id === masterId)
        for (const p of t) this._persistRepeats(p)
        this.upsert(task)
      } else {
        // 保留重复：统一同步逻辑（与今日任务 / 时间胶囊编辑一致），只改内存，下方统一落盘
        const { taskPids } = this._syncRepeatMasterForTask(task, { masterId })
        for (const tp of taskPids) touchedTasks.add(tp)
      }
      const okTasks = (!task.repeat || touchedTasks.size > 0) ? await this.saveProjectNow(pid) : true
      const okRepeats = await this.saveRepeatsNow(pid)
      if (okTasks && okRepeats) return true
      this.tasks[pid] = tasksSnap
      this.repeats[pid] = repeatsSnap
      await idbPut('tasks', taskCacheKey(auth.username, pid), tasksSnap)
      await idbPut('repeats', repeatsCacheKey(auth.username, pid), repeatsSnap)
      return false
    },
    /**
     * 删除“未来任务”中的某一次重复出现（单日处理）：
     * - 若 id 是重复模板（repeats 中 master.template.id），只把「对应那一天」的重复出现存入时间胶囊：
     *   生成 status=deleted 的单日回收站记录，并在根任务与模板上标记 repeatProcessed[day]='deleted'；
     *   其它未来出现、已完成的历史重复日与源任务都不受影响；date 缺省用该模板的到期日；
     * - 活跃待办重复任务：统一「按天入舱」——显式 date（未来任务卡/日历图）用该天，缺省默认「今天」
     *   （当天显示=当天出现）；只删对应那一天，任务本身保留待办，其它重复日不受影响；
     *   若该天之后已无任何未处理重复日（dates 仅剩该天 / endAfter 已到），链自然结束，
     *   写按天记录后把任务移出活跃列表，避免留下不可见的悬空待办；
     * - 已完成重复任务：归档该完成记录（保持已完成、留在完成当天），但保留重复模板，
     *   后续未完成出现继续保留——入舱同样不打断重复链；
     * - 普通未来/今日任务（非重复）走软删（入回收站）。
     */
    async deleteFutureTaskConfirmed(taskId: string, date?: string): Promise<boolean> {
      let masterPid: string | undefined
      let master: RepeatMaster | undefined
      for (const pid of Object.keys(this.repeats)) {
        const m = (this.repeats[pid] ?? []).find((x) => !x.deletedAt && x.template.id === taskId)
        if (m) {
          masterPid = pid
          master = m
          break
        }
      }
      if (master && masterPid !== undefined) {
        const rootId = master.rootTaskId ?? master.template.repeatRootId ?? master.id ?? taskId
        const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
        const trashPid = master.template.projectId || masterPid
        return await this._deleteOccurrence(
          taskId,
          date ?? master.dueDate,
          rootId,
          root,
          master.template,
          masterPid,
          trashPid,
        )
      }
      // 活跃待办重复任务：统一「按天入舱」（见方法注释），只删对应那一天，任务保留待办
      const active = this.all.find((x) => x.id === taskId)
      if (active?.repeat && active.status === 'pending') {
        const day = date ?? todayKey()
        const hasFuture = hasNextUnprocessedRepeatDay(active.repeat, day, active.repeatProcessed, active.repeat.endAfter)
        const ok = await this._deleteOccurrence(
          taskId,
          day,
          rootIdOf(active),
          active,
          active,
          undefined,
          active.projectId,
        )
        if (!ok) return false
        // 链已自然结束：按天记录已写入，把任务移出活跃列表，避免留下不可见的悬空待办。
        // 任务整体离开活跃列表须补写墓碑（先墓碑后 tasks）：否则其它设备会把它并集写回
        // OSS 复活——链结束删除同样缺防复活证据（与 softDeleteConfirmed 同族 BUG）。
        if (!hasFuture) {
          const auth = useAuthStore()
          const list = this.tasks[active.projectId] ?? []
          this.tasks[active.projectId] = list.filter((x) => x.id !== taskId)
          await this.upsertTombstones(active.projectId, [active])
          await this.saveTombstonesNow(active.projectId)
          const saved = await this.saveProjectNow(active.projectId)
          if (!saved) {
            this.tasks[active.projectId] = list
            await idbPut('tasks', taskCacheKey(auth.username, active.projectId), list)
            return false
          }
        }
        return true
      }
      // 已完成重复任务入舱：归档该完成记录（保持已完成、留在完成当天），但保留重复模板，
      // 后续未完成出现继续保留，与待办重复任务「只删对应那天」统一（入舱不打断重复链）
      if (active?.repeat && active.status === 'completed') {
        return this.softDeleteConfirmed(taskId, { keepRepeatMaster: true })
      }
      return this.softDeleteConfirmed(taskId)
    },
    /** 单日删除共用逻辑：标记根任务/模板 repeatProcessed[date]='deleted'，生成单日已删除回收站记录并落盘。
     *  成功返回 true；失败回滚内存与 IDB 返回 false。 */
    async _deleteOccurrence(
      taskId: string,
      day: string,
      rootId: string,
      root: Task | undefined,
      source: Task,
      masterPid: string | undefined,
      trashPid: string,
    ): Promise<boolean> {
      const auth = useAuthStore()
      const rootActivePid = Object.entries(this.tasks).find(([, l]) => l.some((x) => x.id === rootId))?.[0]
      const rootInTrash = Object.entries(this.trash).find(([, l]) => l.some((x) => x.id === rootId))?.[0]
      await this.loadTrash(trashPid)
      if (rootInTrash && rootInTrash !== trashPid) await this.loadTrash(rootInTrash)
      // 快照：涉及项目的 tasks（浅拷贝）/ repeats（深拷贝，模板会被原地改）/ trash + 根任务深拷贝
      const tasksSnap = new Map<string, Task[]>()
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      const trashSnap = new Map<string, Task[]>()
      if (rootActivePid) tasksSnap.set(rootActivePid, (this.tasks[rootActivePid] ?? []).slice())
      // 活跃分支（masterPid === undefined）时 source 是被入舱的活跃重复任务本身，其所在项目
      // 可能不等于根任务项目、或根任务已不在活跃列表（已完成入回收站）。若只按 rootActivePid
      // 落盘，source 的 repeatProcessed 标记与顺延后的时间只存在于内存，本端刷新或其它端
      // 同步后任务会按旧版本「复活」（用户反馈 Bug）。因此 source 所在活跃项目必须纳入快照与落盘。
      const sourceActivePid = Object.entries(this.tasks).find(([, l]) => l.some((x) => x.id === source.id))?.[0]
      if (sourceActivePid && sourceActivePid !== rootActivePid) {
        tasksSnap.set(sourceActivePid, (this.tasks[sourceActivePid] ?? []).slice())
      }
      if (masterPid) repeatsSnap.set(masterPid, JSON.parse(JSON.stringify(this.repeats[masterPid] ?? [])))
      trashSnap.set(trashPid, (this.trash[trashPid] ?? []).slice())
      if (rootInTrash && rootInTrash !== trashPid) trashSnap.set(rootInTrash, (this.trash[rootInTrash] ?? []).slice())
      const rootSnap = root ? JSON.parse(JSON.stringify(root)) : undefined
      const sourceSnap = source !== root ? JSON.parse(JSON.stringify(source)) : undefined
      // 标记该重复日为已删除：根任务与模板的 repeatProcessed 都写入，
      // 保证物化 / 日历 / 未来任务区都不再显示这一天
      if (root) {
        root.repeatProcessed = { ...(root.repeatProcessed ?? {}), [day]: 'deleted' }
        root.updatedAt = nowIso()
      }
      if (source && source !== root) {
        source.repeatProcessed = { ...(source.repeatProcessed ?? {}), [day]: 'deleted' }
      }
      // 活跃分支（masterPid === undefined，物化出的任务承担后续周期）时，repeats 中可能仍残留
      // 与该链同源的模板（其它端尚未同步物化移除 / 本地物化写盘失败的竞态）。此时必须同样在模板
      // 上标记 repeatProcessed[day]='deleted'，否则其它端按旧模板物化时会重新生成这一天（复活）。
      // 先快照（供失败回滚）再原地改模板。
      let linkedRepeatsPid: string | undefined
      if (masterPid === undefined) {
        for (const pid of Object.keys(this.repeats)) {
          const m = (this.repeats[pid] ?? []).find(
            (x) => !x.deletedAt && (x.sourceTaskId === rootId || x.template.id === taskId || x.template.id === source.id),
          )
          if (m) {
            linkedRepeatsPid = pid
            if (!repeatsSnap.has(pid)) repeatsSnap.set(pid, JSON.parse(JSON.stringify(this.repeats[pid] ?? [])))
            break
          }
        }
        if (linkedRepeatsPid !== undefined) {
          const mlist = this.repeats[linkedRepeatsPid] ?? []
          const mi = mlist.findIndex(
            (m) =>
              !m.deletedAt &&
              (m.sourceTaskId === rootId || m.template.id === taskId || m.template.id === source.id),
          )
          if (mi >= 0) {
            const m = mlist[mi]
            mlist[mi] = {
              ...m,
              template: { ...m.template, repeatProcessed: { ...(m.template.repeatProcessed ?? {}), [day]: 'deleted' } },
              updatedAt: nowIso(),
            }
            this.repeats[linkedRepeatsPid] = [...mlist]
          }
        }
      }
      // 生成单日已删除记录（入回收站，按当天分片）
      const occTime = source.reminderTime ?? source.startTime ?? source.endTime ?? `${day}T00:00:00+08:00`
      // 单日处理（入舱/删除）后，若该重复模板的 dueDate 恰好在已处理日上，立即推进到下一个未处理重复日：
      // 否则未来任务区 / 日历图会一直看不到下一次，直到下次加载/同步触发物化才推进。
      // 无剩余未处理重复日则删除模板（链条自然结束）。
      if (masterPid !== undefined) {
        const mlist = this.repeats[masterPid] ?? []
        const mi = mlist.findIndex((m) => !m.deletedAt && m.template.id === source.id)
        if (mi >= 0 && source.repeatProcessed?.[mlist[mi].dueDate]) {
          const mrule = source.repeat
          const advanced = mrule
            ? skipProcessedRepeatDays(mrule, mlist[mi].dueDate, source.repeatProcessed)
            : null
          if (advanced && !(mrule?.endAfter && advanced > mrule.endAfter)) {
            mlist[mi] = {
              ...mlist[mi],
              dueDate: advanced,
              template: shiftTaskTimes(mlist[mi].template, diffDaysKey(mlist[mi].dueDate, advanced)),
              updatedAt: nowIso(),
            }
          } else {
            // 无剩余未处理重复日：写墓碑结束链条（R4：防离线端把已结束链条并集写回）
            mlist[mi] = { ...mlist[mi], deletedAt: nowIso(), updatedAt: nowIso() }
          }
          this.repeats[masterPid] = [...mlist]
        }
      }
      const deletedRecord = normalizeTask({
        ...source,
        id: `${rootId}::${day}`,
        status: 'deleted' as const,
        updatedAt: occTime,
        projectId: trashPid,
        repeatOccurrence: { rootId, date: day, kind: 'deleted' },
      })
      this.trash[trashPid] = mergeUnique(this.trash[trashPid] ?? [], [deletedRecord])
      if (!this.trashLoaded.includes(trashPid)) this.trashLoaded.push(trashPid)
      // 活跃待办重复任务按天入舱后，任务本身就地顺延到下一个「未处理」重复日（用户反馈 Bug）：
      // 入舱只标记 repeatProcessed[day]='deleted' 并生成单日胶囊记录，任务仍滞留为 pending；
      // 若不顺延，其 reminderTime/起止时间一直停留在被入舱那天，第二天界面/小组件显示的仍是
      // 昨天的提醒时间，且提醒上报继续携带旧时间。此处把任务时间平移到下一个未处理重复日
      // （跳过已单日完成/删除的日期，语义与模板推进一致）；无剩余重复日或已超 endAfter 时
      // 保持原样，由调用方 deleteFutureTaskConfirmed 的 hasFuture 分支负责移出活跃列表。
      if (masterPid === undefined && source.repeat && source.status === 'pending') {
        const ownDay = dateKeyOf(source.reminderTime || source.endTime || source.startTime || '')
        if (ownDay && day >= ownDay) {
          const processed = source.repeatProcessed ?? {}
          let next = nextRepeatDate(source.repeat, ownDay)
          let guard = 0
          while (next && processed[next] && guard < 400) {
            const nd = nextRepeatDate(source.repeat, next)
            if (!nd || nd <= next) {
              next = null
              break
            }
            next = nd
            guard++
          }
          if (next && next > ownDay && !(source.repeat.endAfter && next > source.repeat.endAfter)) {
            const offset = diffDaysKey(ownDay, next)
            source.startTime = source.startTime ? addDays(source.startTime, offset) : ''
            source.endTime = source.endTime ? addDays(source.endTime, offset) : ''
            source.reminderTime = source.reminderTime ? addDays(source.reminderTime, offset) : null
            source.isReminded = false
            source.updatedAt = nowIso()
            if (source.subtasks?.length) {
              source.subtasks = source.subtasks.map((s) => ({
                ...s,
                startTime: s.startTime ? addDays(s.startTime, offset) : '',
                endTime: s.endTime ? addDays(s.endTime, offset) : '',
                reminderTime: s.reminderTime ? addDays(s.reminderTime, offset) : null,
              }))
            }
            // 时间变化影响项目主列表排序键（提醒/开始时间）：就地重排，保持界面顺序与时间一致
            if (rootActivePid) this.tasks[rootActivePid] = sortActiveList(this.tasks[rootActivePid] ?? [])
            if (sourceActivePid && sourceActivePid !== rootActivePid) {
              this.tasks[sourceActivePid] = sortActiveList(this.tasks[sourceActivePid] ?? [])
            }
          }
        }
      }
      // 立即落盘全部涉及项目（source 所在活跃项目必须写入：活跃分支的标记/顺延才有持久化，
      // 否则本端刷新或其它端同步会按旧版本复活该任务）
      const jobs: Promise<boolean>[] = []
      if (rootActivePid) jobs.push(this.saveProjectNow(rootActivePid))
      if (sourceActivePid && sourceActivePid !== rootActivePid) jobs.push(this.saveProjectNow(sourceActivePid))
      if (masterPid) jobs.push(this.saveRepeatsNow(masterPid))
      if (linkedRepeatsPid !== undefined && linkedRepeatsPid !== masterPid) {
        jobs.push(this.saveRepeatsNow(linkedRepeatsPid))
      }
      jobs.push(this.saveTrashNow(trashPid))
      if (rootInTrash && rootInTrash !== trashPid) jobs.push(this.saveTrashNow(rootInTrash))
      const ok = (await Promise.all(jobs)).every(Boolean)
      if (ok) {
        this._syncReminders()
        logAudit('存入时间胶囊', safeDetail(`任务ID：${rootId}，日期：${day}，项目ID：${trashPid}`))
        return true
      }
      // 失败回滚：内存 + IDB
      const objs: Array<{ ref: Task | RepeatMaster; snap: unknown }> = []
      if (root) objs.push({ ref: root, snap: rootSnap })
      if (sourceSnap !== undefined) objs.push({ ref: source, snap: sourceSnap })
      await this._rollbackOccurrence(auth, tasksSnap, repeatsSnap, trashSnap, objs)
      return false
    },
    /** 提前完成“未来任务”/日历中的某一次重复出现（单日处理）：
     *  只完成对应那一天：在根任务与模板上标记 repeatProcessed[date]='completed'，
     *  并生成 status=completed 的单日回收站记录；其它未来出现、已完成历史日与源任务都不受影响，
     *  绝不会一次完成全部周期。
     *  - 重复模板（taskId = master.template.id）或活跃重复任务的未来重复日 → 单日完成；
     *  - 任务自己所属的那一天 / 非重复任务 → 走正常完成（toggleCompleteConfirmed）。 */
    async completeFutureOccurrence(taskId: string, date: string): Promise<boolean> {
      const key = `${taskId}:${date}`
      if (occurrenceSaving.has(key)) return false
      occurrenceSaving.add(key)
      try {
        // 1) 重复模板未来出现：按模板解析根任务与单日记录
        let masterPid: string | undefined
        let master: RepeatMaster | undefined
        for (const pid of Object.keys(this.repeats)) {
          const m = (this.repeats[pid] ?? []).find((x) => !x.deletedAt && x.template.id === taskId)
          if (m) {
            masterPid = pid
            master = m
            break
          }
        }
        if (master && masterPid !== undefined) {
          const rootId = master.rootTaskId ?? master.template.repeatRootId ?? master.id ?? taskId
          const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
          const trashPid = master.template.projectId || masterPid
          return await this._completeOccurrence(taskId, date, rootId, root, master.template, masterPid, trashPid)
        }
        // 2) 活跃任务：非重复任务走正常完成；重复任务只把「未来重复日」单日完成，
        //    任务自己所属的那一天仍走正常完成（翻转状态 + 生成未来模板）
        const active = this.all.find((x) => x.id === taskId)
        if (!active) return false
        if (!active.repeat) return this.toggleCompleteConfirmed(taskId)
        const ownDay = dateKeyOf(active.reminderTime || active.startTime || active.endTime)
        if (!ownDay || date === ownDay) return this.toggleCompleteConfirmed(taskId)
        const rootId = rootIdOf(active)
        const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
        return await this._completeOccurrence(taskId, date, rootId, root, active, undefined, active.projectId)
      } finally {
        occurrenceSaving.delete(key)
      }
    },
    /** 单日完成共用逻辑：标记根任务/模板 repeatProcessed[date]='completed'，生成单日已完成回收站记录并落盘。
     *  成功返回 true；失败回滚内存与 IDB 返回 false。 */
    async _completeOccurrence(
      taskId: string,
      day: string,
      rootId: string,
      root: Task | undefined,
      source: Task,
      masterPid: string | undefined,
      trashPid: string,
    ): Promise<boolean> {
      const auth = useAuthStore()
      const rootActivePid = Object.entries(this.tasks).find(([, l]) => l.some((x) => x.id === rootId))?.[0]
      const rootInTrash = Object.entries(this.trash).find(([, l]) => l.some((x) => x.id === rootId))?.[0]
      await this.loadTrash(trashPid)
      if (rootInTrash && rootInTrash !== trashPid) await this.loadTrash(rootInTrash)
      const tasksSnap = new Map<string, Task[]>()
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      const trashSnap = new Map<string, Task[]>()
      if (rootActivePid) tasksSnap.set(rootActivePid, (this.tasks[rootActivePid] ?? []).slice())
      // 活跃分支（masterPid === undefined）时 source 是待完成的活跃重复任务本身，其所在项目
      // 可能不等于根任务项目、或根任务已不在活跃列表（已完成入回收站）。若只按 rootActivePid
      // 落盘，source 的 repeatProcessed 标记只存在于内存，本端刷新或其它端同步后会按旧版本
      // 重新物化/显示该日（与单日删除同一类 Bug）。因此 source 所在活跃项目必须纳入快照与落盘。
      const sourceActivePid = Object.entries(this.tasks).find(([, l]) => l.some((x) => x.id === source.id))?.[0]
      if (sourceActivePid && sourceActivePid !== rootActivePid) {
        tasksSnap.set(sourceActivePid, (this.tasks[sourceActivePid] ?? []).slice())
      }
      if (masterPid) repeatsSnap.set(masterPid, JSON.parse(JSON.stringify(this.repeats[masterPid] ?? [])))
      trashSnap.set(trashPid, (this.trash[trashPid] ?? []).slice())
      if (rootInTrash && rootInTrash !== trashPid) trashSnap.set(rootInTrash, (this.trash[rootInTrash] ?? []).slice())
      const rootSnap = root ? JSON.parse(JSON.stringify(root)) : undefined
      const sourceSnap = source !== root ? JSON.parse(JSON.stringify(source)) : undefined
      if (root) {
        root.repeatProcessed = { ...(root.repeatProcessed ?? {}), [day]: 'completed' }
        root.updatedAt = nowIso()
      }
      if (source && source !== root) {
        source.repeatProcessed = { ...(source.repeatProcessed ?? {}), [day]: 'completed' }
      }
      // 活跃分支（masterPid === undefined）时，repeats 中可能仍残留与该链同源的模板
      // （物化竞态 / 本地物化写盘失败的竞态）。同样在模板上标记 repeatProcessed[day]='completed'，
      // 防止其它端按旧模板物化/显示该日（与单日删除同一类复活 Bug）。先快照再原地改模板。
      let linkedRepeatsPid: string | undefined
      if (masterPid === undefined) {
        for (const pid of Object.keys(this.repeats)) {
          const m = (this.repeats[pid] ?? []).find(
            (x) => !x.deletedAt && (x.sourceTaskId === rootId || x.template.id === taskId || x.template.id === source.id),
          )
          if (m) {
            linkedRepeatsPid = pid
            if (!repeatsSnap.has(pid)) repeatsSnap.set(pid, JSON.parse(JSON.stringify(this.repeats[pid] ?? [])))
            break
          }
        }
        if (linkedRepeatsPid !== undefined) {
          const mlist = this.repeats[linkedRepeatsPid] ?? []
          const mi = mlist.findIndex(
            (m) =>
              !m.deletedAt &&
              (m.sourceTaskId === rootId || m.template.id === taskId || m.template.id === source.id),
          )
          if (mi >= 0) {
            const m = mlist[mi]
            mlist[mi] = {
              ...m,
              template: { ...m.template, repeatProcessed: { ...(m.template.repeatProcessed ?? {}), [day]: 'completed' } },
              updatedAt: nowIso(),
            }
            this.repeats[linkedRepeatsPid] = [...mlist]
          }
        }
      }
      const occTime =
        source.reminderTime ?? source.startTime ?? source.endTime ?? `${day}T00:00:00+08:00`
      // 单日处理后，若该重复模板的 dueDate 恰好在已处理日上，立即推进到下一个未处理重复日：
      // 否则未来任务区 / 日历图会一直看不到下一次，直到下次加载/同步触发物化才推进
      // （即用户感受到的「要多刷新几次才更新」）。无剩余未处理重复日则删除模板（链条自然结束）。
      if (masterPid !== undefined) {
        const mlist = this.repeats[masterPid] ?? []
        const mi = mlist.findIndex((m) => !m.deletedAt && m.template.id === source.id)
        if (mi >= 0 && source.repeatProcessed?.[mlist[mi].dueDate]) {
          const mrule = source.repeat
          const advanced = mrule
            ? skipProcessedRepeatDays(mrule, mlist[mi].dueDate, source.repeatProcessed)
            : null
          if (advanced && !(mrule?.endAfter && advanced > mrule.endAfter)) {
            mlist[mi] = {
              ...mlist[mi],
              dueDate: advanced,
              template: shiftTaskTimes(mlist[mi].template, diffDaysKey(mlist[mi].dueDate, advanced)),
              updatedAt: nowIso(),
            }
          } else {
            // 无剩余未处理重复日：写墓碑结束链条（R4：防离线端把已结束链条并集写回）
            mlist[mi] = { ...mlist[mi], deletedAt: nowIso(), updatedAt: nowIso() }
          }
          this.repeats[masterPid] = [...mlist]
        }
      }
      const completedRecord = normalizeTask({
        ...source,
        id: `${rootId}::${day}`,
        status: 'completed' as const,
        updatedAt: occTime,
        projectId: trashPid,
        repeatOccurrence: { rootId, date: day, kind: 'completed' },
      })
      this.trash[trashPid] = mergeUnique(this.trash[trashPid] ?? [], [completedRecord])
      if (!this.trashLoaded.includes(trashPid)) this.trashLoaded.push(trashPid)
      const jobs: Promise<boolean>[] = []
      if (rootActivePid) jobs.push(this.saveProjectNow(rootActivePid))
      if (sourceActivePid && sourceActivePid !== rootActivePid) jobs.push(this.saveProjectNow(sourceActivePid))
      if (masterPid) jobs.push(this.saveRepeatsNow(masterPid))
      if (linkedRepeatsPid !== undefined && linkedRepeatsPid !== masterPid) {
        jobs.push(this.saveRepeatsNow(linkedRepeatsPid))
      }
      jobs.push(this.saveTrashNow(trashPid))
      if (rootInTrash && rootInTrash !== trashPid) jobs.push(this.saveTrashNow(rootInTrash))
      const ok = (await Promise.all(jobs)).every(Boolean)
      if (ok) {
        await useStatsStore().addDelta(1, root?.id ?? rootId, day)
        this._syncReminders()
        logAudit('完成任务', safeDetail(`任务ID：${rootId}，日期：${day}，项目ID：${trashPid}`))
        return true
      }
      const objs: Array<{ ref: Task | RepeatMaster; snap: unknown }> = []
      if (root) objs.push({ ref: root, snap: rootSnap })
      if (sourceSnap !== undefined) objs.push({ ref: source, snap: sourceSnap })
      await this._rollbackOccurrence(auth, tasksSnap, repeatsSnap, trashSnap, objs)
      return false
    },
    /** 回滚单日完成/删除操作：恢复 tasks（浅拷贝数组）/ repeats（深拷贝）/ trash 数组与原地改过的对象，
     *  内存与 IDB 一并还原。 */
    async _rollbackOccurrence(
      auth: ReturnType<typeof useAuthStore>,
      tasks: Map<string, Task[]>,
      repeats: Map<string, RepeatMaster[]>,
      trash: Map<string, Task[]>,
      objs: Array<{ ref: Task | RepeatMaster; snap: unknown }>,
    ): Promise<void> {
      for (const { ref, snap } of objs) Object.assign(ref, snap as object)
      for (const [pid, list] of tasks) {
        this.tasks[pid] = list
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of repeats) {
        this.repeats[pid] = list
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of trash) {
        this.trash[pid] = list
        await idbPut('trash', trashCacheKey(auth.username, pid), list)
      }
    },

    /** 确认式恢复任务：跨项目时同时保存新旧项目；单日记录恢复会清除根任务/模板上的
     *  repeatProcessed 并写回根任务所在项目，因此把可能触及的项目一并快照与落盘，
     *  成功才返回 true；失败回滚并返回 false。 */
    async restoreConfirmed(id: string, toProjectId?: string): Promise<boolean> {
      const auth = useAuthStore()
      let sourcePid: string | undefined
      let task: Task | undefined
      for (const [pid, list] of Object.entries(this.trash)) {
        const t = list.find((x) => x.id === id)
        if (t) {
          sourcePid = pid
          task = t
          break
        }
      }
      if (sourcePid === undefined) {
        for (const [pid, list] of Object.entries(this.tasks)) {
          const t = list.find((x) => x.id === id && x.status === 'completed')
          if (t) {
            sourcePid = pid
            task = t
            break
          }
        }
      }
      if (sourcePid === undefined) return false
      const targetPid = toProjectId ?? sourcePid
      // 单日记录恢复会清除根任务/模板上的该日标记并写回其所在项目：纳入快照与落盘范围。
      // tasks/trash 涉及源/目标/根项目；repeats 只涉及内存中已加载且含该根同源模板的项目，
      // 避免把未加载项目的 repeats 文件写成空数组。
      const affected = new Set<string>([sourcePid, targetPid])
      const affectedRepeats = new Set<string>()
      if (task?.repeatOccurrence) {
        const rootId = task.repeatOccurrence.rootId
        const root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
        if (root) affected.add(root.projectId)
        for (const [p, ms] of Object.entries(this.repeats)) {
          if ((ms ?? []).some((m) => (m.rootTaskId ?? m.template.repeatRootId ?? m.id) === rootId)) affectedRepeats.add(p)
        }
      }
      const tasksSnap = new Map<string, Task[]>()
      const trashSnap = new Map<string, Task[]>()
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      for (const pid of affected) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
        trashSnap.set(pid, (this.trash[pid] ?? []).slice())
      }
      for (const pid of affectedRepeats) {
        repeatsSnap.set(pid, JSON.parse(JSON.stringify(this.repeats[pid] ?? [])))
      }
      const taskSnap = task ? JSON.parse(JSON.stringify(task)) : undefined
      // 快照墓碑日志：restore 会移除恢复任务的墓碑，失败回滚时一并还原
      const tombstonesSnap = new Map<string, TombstoneSnapshot>()
      for (const pid of affected) {
        tombstonesSnap.set(pid, this.snapshotTombstones(pid))
      }
      this.restore(id, toProjectId)
      // 恢复路径先落墓碑（移除恢复任务的墓碑写盘），再写 tasks/trash，避免其他设备按旧墓碑误杀
      for (const pid of affected) await this.saveTombstonesNow(pid).catch(() => false)
      const jobs: Promise<boolean>[] = []
      for (const pid of affected) {
        jobs.push(this.saveProjectNow(pid))
        jobs.push(this.saveTrashNow(pid))
      }
      for (const pid of affectedRepeats) jobs.push(this.saveRepeatsNow(pid))
      const ok = (await Promise.all(jobs)).every(Boolean)
      if (ok) return true
      // 失败回滚：内存 + IDB（恢复任务对象原地改过，需用深拷贝还原）
      if (task && taskSnap) Object.assign(task, taskSnap)
      for (const [pid, list] of tasksSnap) {
        this.tasks[pid] = list
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of trashSnap) {
        this.trash[pid] = list
        await idbPut('trash', trashCacheKey(auth.username, pid), list)
      }
      for (const [pid, snap] of tombstonesSnap) {
        await this.restoreTombstones(pid, snap)
      }
      for (const [pid, list] of repeatsSnap) {
        this.repeats[pid] = list
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), list)
      }
      return false
    },
    /** 确认式保存「时间胶囊」任务编辑：任务保持在胶囊内（状态不变、完成/入舱时间不变），
     *  编辑结果写回胶囊对应项目分片；跨项目移动时新旧项目都落盘，成功才返回 true，失败回滚并返回 false。 */
    async saveTrashTaskConfirmed(task: Task, opts?: { prevProjectId?: string }): Promise<boolean> {
      const auth = useAuthStore()
      // 任务所在胶囊项目：优先用显式传入的旧项目，否则在已加载胶囊数据中查找
      let sourcePid = opts?.prevProjectId
      if (!sourcePid || !(this.trash[sourcePid] ?? []).some((t) => t.id === task.id)) {
        for (const [pid, list] of Object.entries(this.trash)) {
          if (list.some((t) => t.id === task.id)) {
            sourcePid = pid
            break
          }
        }
      }
      if (sourcePid === undefined) return false
      const targetPid = task.projectId || sourcePid
      normalizeTask(task)
      // 快照涉及项目（跨项目移动时新旧两个都要）；tasks 与 repeats 一并快照，
      // 同步重复模板失败（或胶囊写盘失败）时统一回滚
      const tasksSnap = new Map<string, Task[]>()
      const trashSnap = new Map<string, Task[]>()
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      for (const pid of new Set([sourcePid, targetPid])) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
        trashSnap.set(pid, (this.trash[pid] ?? []).slice())
        repeatsSnap.set(pid, (this.repeats[pid] ?? []).slice())
      }
      // 从源项目胶囊移除旧任务，写入目标项目胶囊（同项目时即原位替换）
      this.trash[sourcePid] = (this.trash[sourcePid] ?? []).filter((t) => t.id !== task.id)
      this.trash[targetPid] = mergeUnique(this.trash[targetPid] ?? [], [task])
      if (!this.trashLoaded.includes(targetPid)) this.trashLoaded.push(targetPid)
      const okSource = await this.saveTrashNow(sourcePid)
      const okTarget = sourcePid === targetPid ? true : await this.saveTrashNow(targetPid)
      if (okSource && okTarget) {
        // 刷新目标项目分片索引，保证「加载更早」可用
        if (sourcePid !== targetPid && auth.creds && targetPid !== UNCATEGORIZED) {
          try {
            const client = await createOssClient(auth.creds)
            const shards = await listTrashShardMonths(client, auth.username, targetPid)
            this.trashShardMonths[targetPid] = shards
            this.trashHasMore[targetPid] = shards.some((m) => !(this.trashLoadedMonths[targetPid] ?? []).includes(m))
          } catch {
            /* 枚举失败不影响保存结果 */
          }
        }
        // 同步重复模板：改到今天/未来 → 今日/未来任务区立即出现对应任务；模板保存失败则整体回滚
        const okRepeats = await this.syncRepeatMasterForCapsuleTask(task, sourcePid === targetPid ? undefined : sourcePid)
        if (okRepeats) {
          logAudit('编辑时间胶囊任务', safeDetail(`任务ID：${task.id}，项目ID：${targetPid}`))
          return true
        }
      }
      for (const [pid, list] of tasksSnap) {
        this.tasks[pid] = list
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of trashSnap) {
        this.trash[pid] = list
        await idbPut('trash', trashCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of repeatsSnap) {
        this.repeats[pid] = list
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), list)
      }
      return false
    },
    /** 确认式永久删除：立即写盘任务+回收站（单日记录还会清除根任务/模板上的该日标记并写回其所在项目），
     *  成功才返回 true；失败回滚并返回 false */
    async permanentDeleteConfirmed(projectId: string, id: string): Promise<boolean> {
      const auth = useAuthStore()
      const target =
        (this.tasks[projectId] ?? []).find((t) => t.id === id) ??
        (this.trash[projectId] ?? []).find((t) => t.id === id)
      const affected = new Set<string>([projectId])
      const affectedRepeats = new Set<string>()
      let root: Task | undefined
      if (target?.repeatOccurrence) {
        const rootId = target.repeatOccurrence.rootId
        root = this.all.find((x) => x.id === rootId) ?? this.allTrash.find((x) => x.id === rootId)
        if (root) affected.add(root.projectId)
        for (const [p, ms] of Object.entries(this.repeats)) {
          if ((ms ?? []).some((m) => (m.rootTaskId ?? m.template.repeatRootId ?? m.id) === rootId)) affectedRepeats.add(p)
        }
      }
      const tasksSnap = new Map<string, Task[]>()
      const trashSnap = new Map<string, Task[]>()
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      const tombstonesSnap = new Map<string, TombstoneSnapshot>()
      for (const pid of affected) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
        trashSnap.set(pid, (this.trash[pid] ?? []).slice())
        tombstonesSnap.set(pid, this.snapshotTombstones(pid))
      }
      for (const pid of affectedRepeats) {
        repeatsSnap.set(pid, JSON.parse(JSON.stringify(this.repeats[pid] ?? [])))
      }
      const rootSnap = root ? JSON.parse(JSON.stringify(root)) : undefined
      this.permanentDelete(projectId, id)
      // 先落「永久删除墓碑」，再写 tasks/trash（与 restoreConfirmed / sweepCompleted 同一写序）：
      // 其它端合并回收站分片/活跃列表时据此剔除，避免记录被并集写回（多端复活）。
      // 墓碑都写不进去就不做不可逆的永久删除：直接回滚并让用户重试。
      const tombOk = (await Promise.all([...affected].map((pid) => this.saveTombstonesNow(pid)))).every(Boolean)
      if (!tombOk) {
        useUiStore().toast('永久删除失败：无法写入防复活墓碑，请检查网络后重试', 'error')
        // 先同步还原全部内存并取消防抖写盘，再做 IDB/墓碑还原：
        // 否则还原过程中的网络等待期间，permanentDelete 排定的防抖写盘会把「已删除」状态写进 OSS
        for (const pid of affected) tombstoneDebouncers.get(pid)?.cancel()
        if (root && rootSnap) Object.assign(root, rootSnap)
        for (const [pid, snap] of tombstonesSnap) await this.restoreTombstones(pid, snap)
        for (const [pid, list] of tasksSnap) this.tasks[pid] = list
        for (const [pid, list] of trashSnap) this.trash[pid] = list
        for (const [pid, list] of repeatsSnap) this.repeats[pid] = list
        for (const pid of affected) {
          await this.saveTombstonesNow(pid).catch(() => false)
        }
        for (const [pid, list] of tasksSnap) {
          await idbPut('tasks', taskCacheKey(auth.username, pid), list)
        }
        for (const [pid, list] of trashSnap) {
          await idbPut('trash', trashCacheKey(auth.username, pid), list)
        }
        for (const [pid, list] of repeatsSnap) {
          await idbPut('repeats', repeatsCacheKey(auth.username, pid), list)
        }
        return false
      }
      const jobs: Promise<boolean>[] = []
      for (const pid of affected) {
        jobs.push(this.saveProjectNow(pid))
        jobs.push(this.saveTrashNow(pid))
      }
      for (const pid of affectedRepeats) jobs.push(this.saveRepeatsNow(pid))
      const ok = (await Promise.all(jobs)).every(Boolean)
      if (ok) return true
      // 失败回滚：先同步还原全部内存（含墓碑，避免「删除没成功、墓碑却留下」导致该任务被其它端
      // 永久剔除），再还原 IDB / 墓碑写盘。根任务对象被原地改过，需用深拷贝还原。
      for (const pid of affected) tombstoneDebouncers.get(pid)?.cancel()
      if (root && rootSnap) Object.assign(root, rootSnap)
      for (const [pid, snap] of tombstonesSnap) await this.restoreTombstones(pid, snap)
      for (const [pid, list] of tasksSnap) this.tasks[pid] = list
      for (const [pid, list] of trashSnap) this.trash[pid] = list
      for (const [pid, list] of repeatsSnap) this.repeats[pid] = list
      for (const pid of affected) {
        await this.saveTombstonesNow(pid).catch(() => false)
      }
      for (const [pid, list] of tasksSnap) {
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of trashSnap) {
        await idbPut('trash', trashCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of repeatsSnap) {
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), list)
      }
      return false
    },
    /** 确认式批量导入：立即写盘涉及的全部项目，成功才返回 true；失败回滚并返回 false */
    async bulkAddConfirmed(list: Task[]): Promise<boolean> {
      const auth = useAuthStore()
      const touchedPids = new Set<string>(list.map((t) => t.projectId))
      const tasksSnap = new Map<string, Task[]>()
      for (const pid of touchedPids) tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
      this.bulkAdd(list)
      const results = await Promise.all([...touchedPids].map((pid) => this.saveProjectNow(pid)))
      if (results.every(Boolean)) return true
      for (const [pid, list] of tasksSnap) {
        this.tasks[pid] = list
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
      }
      return false
    },
    /** 立即落盘所有未保存变更（页面隐藏/关闭、登出前调用）。
     *  这里在清空 store 之前先拷贝快照，避免登出竞态把空数组写到 OSS。 */
    async flushAll() {
      const jobs: Promise<boolean>[] = []
      for (const [pid, list] of Object.entries(this.tasks)) {
        jobs.push(this.saveProject(pid, [...list]))
      }
      for (const [pid, list] of Object.entries(this.trash)) {
        jobs.push(this.saveTrash(pid, [...list]))
      }
      for (const [pid, list] of Object.entries(this.repeats)) {
        jobs.push(this.saveRepeats(pid, [...list]))
      }
      await Promise.allSettled(jobs)
    },
    /** 清空本仓库内存态并取消防抖（登出/切换账号/重新配置凭证后调用） */
    resetAll() {
      for (const fn of saveDebouncers.values()) fn.cancel()
      for (const fn of trashDebouncers.values()) fn.cancel()
      for (const fn of tombstoneDebouncers.values()) fn.cancel()
      saveDebouncers.clear()
      trashDebouncers.clear()
      tombstoneDebouncers.clear()
      tasksSaving.clear()
      trashSaving.clear()
      repeatsSaving.clear()
      tombstonesSaving.clear()
      toggleSaving.clear()
      occurrenceSaving.clear()
      if (syncReminderTimer) {
        window.clearTimeout(syncReminderTimer)
        syncReminderTimer = undefined
      }
      this.tasks = {}
      this.trash = {}
      this.repeats = {}
      this.tombstoneShards = {}
      this.tombstonePurged = {}
      this.tombstonesLoaded = []
      this.loadedProjects = []
      this.trashLoaded = []
      this.trashLoadedMonths = {}
      this.trashShardMonths = {}
      this.trashHasMore = {}
      this.trashLoadedYears = []
      this.trashYear = null
      this.repeatsLoaded = []
      this.todayOrder = []
      // 顺序表元数据同样要清：否则切换账号后残留的 dirty/就位标记会让新账号
      // 用空表覆盖它自己的云端顺序（或让对账误以为权威值已就位）
      this.todayOrderLoaded = false
      this.todayOrderUpdatedAt = ''
      this.todayOrderDirty = false
      this.todayOrderMisses = {}
      // 清空固定集与 LRU 顺序，避免跨账号残留导致新账号项目无法逐出
      viewPins.clear()
      capsulePins.clear()
      accessOrder.length = 0
      evicting = false
    },
  },
})
