import { defineStore } from 'pinia'
import type { OssClient } from '@/utils/oss'
import { useAuthStore } from './auth'
import { useProjectsStore } from './projects'
import { useUiStore } from './ui'
import { useStatsStore } from './stats'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { applyDeletedTombstones, compareAndSwapPut, filterTasksForProject, lastModifiedOf, lmKeyOf, mergeDeletedTombstones, mergeTasks, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbClearTrashUserCache, idbGet, idbListKeys, idbPut, idbDel } from '@/utils/idb'
import { debounce, type Debounced } from '@/utils/debounce'
import { queueSyncChange } from '@/utils/syncReport'
import { addDaysKey, dateKeyOf, diffDaysKey, nowIso, todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { buildOccurrenceTemplate, buildReminderPayload, buildRepeatOccurrence, nextRepeatDate, repeatShapeEquals, rootIdOf, shiftTaskTimes, skipProcessedRepeatDays } from '@/utils/repeat'
import { api } from '@/api/client'
import { logAudit, safeDetail } from '@/utils/audit'
import { UNCATEGORIZED, type AttachmentMeta, type RepeatMaster, type Subtask, type Task } from '@/types'
import { compareSortTime, newSubtask, normalizeTask, normalizeTasks, pendingSubtaskReminders, taskEffectiveEndTime, taskEffectiveSortTime } from '@/utils/task'
import { deleteAttachments } from '@/utils/attachments'
const saveDebouncers = new Map<string, Debounced<[]>>()
const trashDebouncers = new Map<string, Debounced<[]>>()
// 每项目在途保存 Promise：确认式保存/即时保存共用，串行化同一文件的写入，
// 避免同一文件并发 CAS 写互相覆盖或误报“冲突合并”提示
const tasksSaving = new Map<string, Promise<boolean>>()
const trashSaving = new Map<string, Promise<boolean>>()
const repeatsSaving = new Map<string, Promise<boolean>>()
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
 * 项目一旦被拖拽排序（存在 sort 值）就按 sort 升序排列（未分配 sort 的新任务补到末尾），
 * 让手动拖拽顺序在加载/同步合并后保持；从未拖拽过的项目退化为按截止时间升序（旧行为，
 * 截止时间取主任务 + 未完成子任务最早 endTime）。
 */
/** 新建任务插入比较：主任务 + 未完成子任务取最早（地位同等）；同一天按「提醒 > 开始」类型优先级；不同一天按实际时间先后（无时间排最后） */
function compareTaskSort(a: Task, b: Task): number {
  return compareSortTime(taskEffectiveSortTime(a), taskEffectiveSortTime(b))
}
function sortActiveList(list: Task[]): Task[] {
  const hasSort = list.some((t) => t.sort !== undefined)
  const cmp = hasSort
    ? (a: Task, b: Task) => {
        const sa = a.sort ?? Number.MAX_SAFE_INTEGER
        const sb = b.sort ?? Number.MAX_SAFE_INTEGER
        return sa !== sb ? sa - sb : taskEffectiveEndTime(a).localeCompare(taskEffectiveEndTime(b))
      }
    : (a: Task, b: Task) => taskEffectiveEndTime(a).localeCompare(taskEffectiveEndTime(b))
  const pending = list.filter((t) => t.status === 'pending').sort(cmp)
  const rest = list.filter((t) => t.status !== 'pending').sort(cmp)
  return [...pending, ...rest]
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
 */
function filterStaleAcrossProjects(
  allTasks: Record<string, Task[]>,
  projectId: string,
  tasks: Task[],
): Task[] {
  if (!tasks.length) return tasks
  const others: Task[] = []
  for (const [pid, list] of Object.entries(allTasks)) {
    if (pid === projectId) continue
    for (const t of list) others.push(t)
  }
  if (!others.length) return tasks
  return tasks.filter(
    (t) => !others.some((o) => o.id === t.id && (o.updatedAt || '').localeCompare(t.updatedAt || '') > 0),
  )
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
      if (cur && (t.updatedAt || '').localeCompare(cur.updatedAt || '') > 0) staleIds.add(t.id)
    }
  }
  if (!staleIds.size) return result
  return result.filter((t) => !staleIds.has(t.id))
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
function flushAllPendingSaves() {
  for (const fn of saveDebouncers.values()) fn.flush()
  for (const fn of trashDebouncers.values()) fn.flush()
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
    }
  }, 60_000)
}
export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: {} as Record<string, Task[]>,
    trash: {} as Record<string, Task[]>,
    repeats: {} as Record<string, RepeatMaster[]>,
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
  }),
  getters: {
    all: (s) => Object.values(s.tasks).flat(),
    allTrash: (s) => Object.values(s.trash).flat(),
    byProject: (s) => (projectId: string) => s.tasks[projectId] ?? [],
    /** 今日任务侧栏角标：今日视图中可见的进行中任务数 */
    todayCount: (s) => {
      const today = todayKey()
      return Object.values(s.tasks)
        .flat()
        .filter((t) => t.status === 'pending' && isTaskVisibleToday(t, today)).length
    },
    /** 侧栏头部：全部待办任务数（跨项目，仅统计内存中已加载的项目） */
    pendingCount: (s) => Object.values(s.tasks).flat().filter((t) => t.status === 'pending').length,
    /** 侧栏头部：今天已完成任务数（跨项目；完成任务时 updatedAt 记为完成时间） */
    completedTodayCount: (s) => {
      const today = todayKey()
      return Object.values(s.tasks)
        .flat()
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
        if ((s.repeats[id] ?? []).some((m) => m.dueDate <= last)) set.add(id)
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
        this.tasks[projectId] = cachedActive
        await idbPut('tasks', taskCacheKey(auth.username, projectId), cachedActive)
        if (deleted.length) {
          this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], deleted)
          await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
          void this._persistTrash(projectId, true)
        }
      }
      if (!auth.creds) {
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
          this.tasks[projectId] = sortActiveList(
            await filterStaleAcrossProjectsAsync(
              this.tasks,
              projectId,
              filterTasksForProject(active, projectId),
              auth.username,
            ),
          )
          // 跨天归档：非当天完成的已完成任务稍后由 sweepCompleted 统一移入回收站
          await idbPut('tasks', taskCacheKey(auth.username, projectId), this.tasks[projectId])
          if (deleted.length) {
            this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], deleted)
            await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
            void this._persistTrash(projectId, true)
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
    /** 加载今日任务跨项目顺序表：先恢复 IDB 缓存，再条件 GET OSS（304 命中零下载）。 */
    async loadTodayOrder(): Promise<void> {
      const auth = useAuthStore()
      const cacheKey = todayOrderCacheKey(auth.username)
      const cached = await idbGet<{ ids?: string[] }>('kv', cacheKey)
      if (Array.isArray(cached?.ids)) this.todayOrder = cached.ids
      if (!auth.creds) return
      try {
        const client = await createOssClient(auth.creds)
        const etagKey = todayOrderEtagKey(auth.username)
        const lmKey = lmKeyOf(etagKey)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          todayOrderFilePath(auth.username),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status === 304) return
        const remote = JSON.parse(res.content.toString()) as { ids?: string[] }
        const ids = Array.isArray(remote?.ids) ? remote.ids : []
        this.todayOrder = ids
        await idbPut('kv', cacheKey, { ids })
        const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
        if (newEtag) await idbPut('kv', etagKey, newEtag)
        const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
        if (newLm) await idbPut('kv', lmKey, newLm)
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        // 文件不存在（首次使用/未拖拽过）或 304：静默忽略
        if (isServerEmptyError(e) || err.code === 304 || err.status === 304) return
        console.error('加载今日任务顺序失败', e)
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
          if (pendingTasks || pendingTrash) {
            const okTasks = pendingTasks ? await this.saveProjectNow(pid) : true
            const okTrash = pendingTrash ? await this.saveTrashNow(pid) : true
            if (!okTasks || !okTrash) continue // 落盘失败：保留内存，下一轮再试
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
      if (!auth.creds) {
        if (!this.trashLoaded.includes(projectId)) this.trashLoaded.push(projectId)
        return
      }
      try {
        const client = await createOssClient(auth.creds)
        // 旧版 projects/{pid}/trash.json 先迁移到按月分片（幂等，只做一次）
        await migrateLegacyTrash(client, auth.username, projectId)
        const remote = await fetchRemoteTrash(client, auth.username, projectId)
        if (remote.length) {
          this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], remote)
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
        // 有界并发拉取该年各分片（Last-Modified 条件 GET，未变动的月份直接 304 复用缓存）
        const results = await mapLimit(months, TRASH_FETCH_CONCURRENCY, async (m) => {
          const remote = await fetchRemoteTrashShard(client, auth.username, pid, m)
          return { remote }
        })
        for (const { remote } of results) {
          if (remote.length) {
            this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
            changed = true
            taskCount += remote.length
          }
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
        // 先收集结果再串行合并，避免并发写共享 trash[pid] 数组
        const results = await mapLimit(months, TRASH_FETCH_CONCURRENCY, async (m) => {
          const remote = await fetchRemoteTrashShard(client, auth.username, pid, m)
          return { m, remote }
        })
        let changed = false
        for (const { remote } of results) {
          if (remote.length) {
            this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
            changed = true
            taskCount += remote.length
          }
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
        // 有界并发拉取该项目全部分片（Last-Modified 条件 GET，未变动的月份直接 304 复用缓存）
        const results = await mapLimit(allMonths, TRASH_FETCH_CONCURRENCY, async (m) => {
          const remote = await fetchRemoteTrashShard(client, auth.username, pid, m)
          return { m, remote }
        })
        for (const { m, remote } of results) {
          if (remote.length) {
            this.trash[pid] = mergeUnique(this.trash[pid] ?? [], remote)
            changed = true
            taskCount += remote.length
          }
          loadedYears.add(Number(m.slice(0, 4)))
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
     *  供轮询增量同步与 syncAll 复用；远端文件不存在时静默保留本地数据。 */
    async syncProject(projectId: string) {
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
        lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
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
      const localTombstones = this.trash[projectId] ?? []
      const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
      const tombstones = mergeDeletedTombstones(
        localTombstones,
        remoteDeleted,
        remoteTrash,
      )
      const merged = sortActiveList(
        applyDeletedTombstones(mergeTasks(local, remoteActive), tombstones),
      )
      this.tasks[projectId] = merged
      await idbPut('tasks', taskCacheKey(auth.username, projectId), merged)
      const oldTrash = this.trash[projectId] ?? []
      const mergedTrash = mergeUnique(oldTrash, [...remoteDeleted, ...remoteTrash])
      if (JSON.stringify(oldTrash) !== JSON.stringify(mergedTrash)) {
        this.trash[projectId] = mergedTrash
        await idbPut('trash', trashCacheKey(auth.username, projectId), this.trash[projectId])
        void this._persistTrash(projectId, true)
      }
      const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
      if (newEtag) await idbPut('kv', etagKey, newEtag)
      const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
      if (newLm) await idbPut('kv', lmKey, newLm)
      // 合并结果相对远端原始内容有差异（含被过滤掉的过期副本）时写回，
      // 让其他设备也能看到，并顺带“自愈”掉源项目里残留的旧副本（BUG）
      if (JSON.stringify(merged) !== JSON.stringify(rawRemoteActive)) {
        await this.saveProject(projectId, [...merged])
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
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<Task[]>(client, key, list, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
          await idbDel('kv', lmKeyOf(etagKey))
          await idbPut('tasks', taskCacheKey(auth.username, projectId), list)
            queueSyncChange(auth.username, 'tasks', projectId)
          if (attempt > 0) useUiStore().toast('检测到其他设备同时修改，已自动合并最新数据', 'ok')
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
          const localTombstones = this.trash[projectId] ?? []
          const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
          const tombstones = mergeDeletedTombstones(
            localTombstones,
            remoteDeleted,
            remoteTrash,
          )
          list = sortActiveList(applyDeletedTombstones(mergeTasks(list, filteredRemote), tombstones))
          knownEtag = result.remoteEtag ?? undefined
          if (!snapshot) {
            this.tasks[projectId] = list
            await idbPut('tasks', taskCacheKey(auth.username, projectId), list)
            const oldTrash = this.trash[projectId] ?? []
            const mergedTrash = mergeUnique(oldTrash, [...remoteDeleted, ...remoteTrash])
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
     *  返回 { ok, merged }：merged 为冲突合并后实际写入（或即将写入）的任务列表。 */
    async _saveTrashShard(
      client: OssClient,
      username: string,
      projectId: string,
      month: string | undefined,
      list: Task[],
    ): Promise<{ ok: boolean; merged: Task[] }> {
      const key = trashFilePath(username, projectId, month)
      const etagKey = `etag:${username}:${projectId}:trash${month ? `:${month}` : ''}`
      const cacheKey = trashCacheKey(username, projectId, month)
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
        if (result.remote) {
          const remoteList = [...(result.remote as Task[])]
          normalizeTasks(remoteList)
          list = mergeTasks(list, remoteList)
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
      let list = (snapshot ?? this.trash[projectId] ?? []).slice()
      // 未分类回收站：单文件直写（不分片）
      if (projectId === UNCATEGORIZED) {
        const r = await this._saveTrashShard(client, auth.username, projectId, undefined, list)
        if (!r.ok) {
          useUiStore().toast('保存时间胶囊失败：检测到其他设备持续修改，请稍后重试', 'error')
          return false
        }
        await idbPut('trash', trashCacheKey(auth.username, projectId), list)
        queueSyncChange(auth.username, 'trash', projectId)
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
            const merged = mergeUnique(remote, byMonth.get(m) ?? [])
            byMonth.set(m, merged)
            this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], merged)
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
    /** 立即保存该项目回收站（取消防抖，供“确认式保存”使用）；成功返回 true */
    async saveTrashNow(projectId: string): Promise<boolean> {
      trashDebouncers.get(projectId)?.cancel()
      const prev = trashSaving.get(projectId)
      if (prev) await prev.catch(() => {})
      const p = this.saveTrash(projectId).finally(() => {
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
    /** 供项目仓库回滚使用：恢复指定项目的任务/回收站/重复模板（内存 + IDB） */
    async rollbackProject(
      projectId: string,
      snap: { tasks?: Task[]; trash?: Task[]; repeats?: RepeatMaster[] },
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
    },
    /** 拉取重复模板（独立文件，按需加载，仅主任务完成后生成） */
    async loadRepeats(projectId: string) {
      this.touchProject(projectId)
      const auth = useAuthStore()
      if (this.repeatsLoaded.includes(projectId)) return
      const cached = await idbGet<RepeatMaster[]>('repeats', repeatsCacheKey(auth.username, projectId))
      if (cached) this.repeats[projectId] = cached
      if (!auth.creds) return
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
      this.repeatsLoaded.push(projectId)
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
            return true
          }
          // 冲突：按 id 去重合并（本地优先），不丢失任一端修改
          if (result.remote) {
            const remote = result.remote as RepeatMaster[]
            const seen = new Set(list.map((m) => m.id))
            const merged = [...list, ...(remote ?? []).filter((m) => !seen.has(m.id))]
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
    },
    /**
     * 重复任务物化：到期的重复模板生成可见任务（新 id、pending，时间按周期顺延）；
     * 过期多日时跳过缺失周期，只保留“今天”这一次（跳过≠补发）；endAfter 已过则删除模板。
     * 物化后模板删除，由该物化任务自己承担后续周期（再次完成时重新生成模板）。
     * 在加载 / 同步 / 跨天检测时调用，不在普通编辑 _persist 里调用。
     */
    async materializeRepeats(projectId?: string) {
      // 串行调度：轮询同步 / 跨天定时器 / 打开项目可能并发触发物化，同一批到期模板被并发
      // 读取会重复生成两份任务。串行后第二个调用基于第一个已完成的状态执行（到期模板已被
      // 移除），不会重复物化；队列内单个调用失败只影响该调用，不阻断后续物化。
      const run = materializeChain.then(() => this._materializeRepeats(projectId))
      materializeChain = run.catch(() => undefined)
      return run
    },
    /** 实际的到期物化逻辑（由 materializeRepeats 串行调度后执行，避免并发重复生成） */
    async _materializeRepeats(projectId?: string) {
      const auth = useAuthStore()
      const today = todayKey()
      const pids = projectId ? [projectId] : Object.keys(this.repeats)
      for (const pid of pids) {
        if (!this.repeatsLoaded.includes(pid)) await this.loadRepeats(pid)
        const masters = this.repeats[pid] ?? []
        if (!masters.length) continue
        const remaining: RepeatMaster[] = []
        const toAdd: Task[] = []
        let changed = false
        for (const master of masters) {
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
          // 生成的任务 id 一致，配合下方 list.some(id) 检查与跨端 mergeTasks（按 id 合并），
          // 可避免把同一个重复任务重复生成两份。id 仍为 buildRepeatOccurrence 生成的 UUID。
          const template = shiftTaskTimes(master.template, diffDaysKey(master.dueDate, dueDate))
          toAdd.push({
            ...template,
            id: master.template.id,
            status: 'pending',
            isReminded: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
          changed = true
        }
        if (changed) {
          this.repeats[pid] = remaining
          this._persistRepeats(pid)
        }
        for (const task of toAdd) {
          const list = this.tasks[pid] ?? []
          if (list.some((t) => t.id === task.id)) continue
          this.tasks[pid] = sortActiveList([...list, task])
          this._persist(pid)
          // 物化出的重复任务也登记到今日顺序表末尾，避免刷新后按截止时间重排打乱已拖拽顺序
          if (isTaskVisibleToday(task, todayKey()) && !this.todayOrder.includes(task.id)) {
            this.todayOrder = [...this.todayOrder, task.id]
            void this.saveTodayOrderNow()
          }
          logAudit('生成重复任务', safeDetail(`任务ID：${task.id}，项目ID：${pid}，周期：${task.repeat?.type ?? ''}`))
        }
      }
    },
    /** 删除某任务对应的重复模板（软删/永久删/取消完成/恢复时调用） */
    _deleteMasterForTask(taskId: string) {
      for (const pid of Object.keys(this.repeats)) {
        const masters = this.repeats[pid] ?? []
        if (!masters.some((m) => m.sourceTaskId === taskId)) continue
        this.repeats[pid] = masters.filter((m) => m.sourceTaskId !== taskId)
        this._persistRepeats(pid)
      }
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
        if ((ms ?? []).some((m) => m.sourceTaskId === task.id)) snapPids.add(p)
      }
      const repeatsSnap = new Map<string, RepeatMaster[]>()
      for (const p of snapPids) {
        if (!this.repeatsLoaded.includes(p)) await this.loadRepeats(p)
        repeatsSnap.set(p, (this.repeats[p] ?? []).slice())
      }
      // 统一同步逻辑（只改内存 + 返回触及项目）：已完成胶囊任务会创建/更新模板（> 今天），
      // 今天的已完成记录保持完成，不会物化出「今天」的新任务
      const touched = this._syncRepeatMasterForTask(task)
      const results = await Promise.all([...touched].map((p) => this.saveRepeatsNow(p)))
      if (results.every(Boolean)) {
        this._syncReminders()
        return true
      }
      // 失败回滚：恢复内存 + IDB，并尽力把已写入 OSS 的模板文件还原为保存前快照
      for (const [p, list] of repeatsSnap) {
        this.repeats[p] = list
        await idbPut('repeats', repeatsCacheKey(auth.username, p), list)
        await this.saveRepeats(p, list).catch(() => {})
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
     */
    _syncRepeatMasterForTask(task: Task, opts?: { masterId?: string }): Set<string> {
      const touched = new Set<string>()
      const rule = task.repeat
      if (!rule) {
        // 移除重复：删除同源全部模板（跨项目迁移时一并清旧项目残留）
        for (const pid of Object.keys(this.repeats)) {
          const masters = this.repeats[pid] ?? []
          if (!masters.some((m) => m.sourceTaskId === task.id)) continue
          this.repeats[pid] = masters.filter((m) => m.sourceTaskId !== task.id)
          touched.add(pid)
        }
        return touched
      }
      const today = todayKey()
      // 定位既有模板：未来任务编辑按 masterId（模板 id），其余按 sourceTaskId（源任务 id）
      let pid: string | undefined
      let idx = -1
      const findMaster = (pred: (m: RepeatMaster) => boolean): { pid?: string; idx: number } => {
        for (const k of Object.keys(this.repeats)) {
          const i = (this.repeats[k] ?? []).findIndex(pred)
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
      if (!targetPid || targetPid === UNCATEGORIZED) return touched
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
        if (opts?.masterId) return touched
        if (task.status !== 'completed') return touched
        const occ = buildRepeatOccurrence(task, today)
        if (!occ) return touched
        const now = nowIso()
        this.repeats[targetPid] = [
          ...masters,
          {
            id: task.id,
            projectId: targetPid,
            sourceTaskId: task.id,
            rootTaskId: rootIdOf(task),
            dueDate: occ.dueDate,
            template: occ.template,
            createdAt: now,
            updatedAt: now,
          },
        ]
        touched.add(targetPid)
        return touched
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
            // 剩余重复日全部已处理或已过结束日：删除模板，链条自然结束
            this.repeats[targetPid] = masters.filter((m) => m.id !== master.id)
            touched.add(targetPid)
            return touched
          }
          dueDate = advanced
        }
        const anchor =
          task.reminderTime || task.endTime || task.startTime
            ? dateKeyOf(task.reminderTime || task.endTime || task.startTime)
            : (rule.start ?? dueDate)
        const occ = buildOccurrenceTemplate(task, rule, anchor, dueDate)
        const next = [...masters]
        next[idx] = {
          ...master,
          projectId: targetPid,
          dueDate,
          template: { ...occ.template, id: master.template.id },
          updatedAt: nowIso(),
        }
        this.repeats[targetPid] = next
        touched.add(targetPid)
        return touched
      }
      // 规则形状变化 / 老模型：按新规则重算「严格 > 今天」的下一次出现
      const occ = buildRepeatOccurrence(task, today)
      if (!occ) {
        this.repeats[targetPid] = masters.filter((m) => m.id !== master.id)
        touched.add(targetPid)
        return touched
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
      return touched
    },
    _syncReminders() {
      if (syncReminderTimer) window.clearTimeout(syncReminderTimer)
      syncReminderTimer = window.setTimeout(() => {
        void this.syncReminders()
      }, 300)
    },
    async syncReminders() {
      const auth = useAuthStore()
      if (!auth.token || !this.hasAny()) return
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
          const t = m.template
          const carrier = { ...t, id: m.id }
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
      if (!loadedPids.length && !rows.length) return
      await api.syncReminders(rows, loadedPids)
    },
    hasAny(): boolean {
      return Object.keys(this.tasks).length > 0
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
        Object.assign(list[idx], task)
      } else {
        // 新建/跨项目移入：不继承旧项目的 sort；仅把该任务按「同一天提醒 > 开始，
        // 不同一天按实际时间先后」插入当前顺序的合适位置（其他任务顺序保持不变），
        // 再整体重排 sort 序号，使新顺序在加载/同步合并后依然保持
        const pendingEnd = list.findIndex((t) => t.status !== 'pending')
        const bound = pendingEnd === -1 ? list.length : pendingEnd
        let at = 0
        while (at < bound && compareTaskSort(list[at], task) <= 0) at++
        list.splice(at, 0, task)
        list.forEach((t, i) => {
          t.sort = i
        })
      }
      // 新任务若是今日可见，登记到今日顺序表末尾（独立小文件后台落盘，失败不影响主保存），
      // 保证今日视图里新任务的位置跨设备一致，而不是每次按截止时间重排
      if (isNew && isTaskVisibleToday(task, todayKey())) {
        this.todayOrder = [...this.todayOrder.filter((id) => id !== task.id), task.id]
        void this.saveTodayOrderNow()
      }
      this.tasks[target] = list
      this._persist(target)
      // 编辑源任务后同步重复模板（与时间胶囊 / 未来任务编辑同一套统一逻辑）：
      // 保持后续周期属性一致；移除重复则删除模板（周期提醒随之停止）。
      // 统一方法只改内存并返回触及项目，这里按原行为防抖落盘。
      const touchedRepeats = this._syncRepeatMasterForTask(task)
      for (const pid of touchedRepeats) this._persistRepeats(pid)
      logAudit(isNew ? '新增任务' : '修改任务', safeDetail(`任务ID：${task.id}，项目ID：${target}`))
    },
    /**
     * 拖拽排序：整体替换该项目的任务数组（顺序即展示顺序）。
     * 写入每个任务的 sort=下标，并仅对「位置发生变化的任务」更新 updatedAt，
     * 使本端的 sort 值在跨设备合并（mergeTasks 按 updatedAt 取新）时胜出；
     * 未移动的任务保持原 updatedAt，避免覆盖其他设备对该任务的内容编辑。
     */
    setOrder(projectId: string, ordered: Task[]) {
      const prev = this.tasks[projectId] ?? []
      const prevIndex = new Map(prev.map((t, i) => [t.id, i]))
      const now = nowIso()
      for (let i = 0; i < ordered.length; i++) {
        const t = ordered[i]
        const oldIdx = prevIndex.get(t.id)
        const moved = oldIdx === undefined || oldIdx !== i || t.sort !== i
        t.sort = i
        if (moved) t.updatedAt = now
      }
      this.tasks[projectId] = ordered
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
     * 保存今日视图的跨项目拖拽顺序（任务 id 全局有序）。
     * 顺序表独立于各项目 tasks.json 单独存储 + CAS + 同步上报，保证换设备后
     * 今日视图的排列与拖拽时完全一致；展示时按「今日可见 + 仍存在」过滤引用。
     */
    setTodayOrder(orderedIds: string[]) {
      this.todayOrder = [...orderedIds]
      void idbPut('kv', todayOrderCacheKey(useAuthStore().username), { ids: this.todayOrder })
      void this.saveTodayOrderNow()
      logAudit('调整今日任务顺序', safeDetail(`共 ${orderedIds.length} 项`))
    },
    /** 立即把今日顺序表落盘 OSS（CAS + 冲突合并：本地顺序优先，远端新增 id 追加到末尾） */
    async saveTodayOrderNow(): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      try {
        const client = await createOssClient(auth.creds)
        const key = todayOrderFilePath(auth.username)
        const etagKey = todayOrderEtagKey(auth.username)
        let knownEtag = await idbGet<string>('kv', etagKey)
        const payload = { ids: this.todayOrder }
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await compareAndSwapPut<{ ids: string[] }>(client, key, payload, knownEtag)
          if (result.ok) {
            if (result.etag) await idbPut('kv', etagKey, result.etag)
            // 本地写入成功后清掉 Last-Modified，避免下一轮读路径用旧时间条件 GET 误判 304
            await idbDel('kv', lmKeyOf(etagKey))
            await idbPut('kv', todayOrderCacheKey(auth.username), { ids: this.todayOrder })
            queueSyncChange(auth.username, 'today_order', null)
            return true
          }
          if (result.remote && Array.isArray((result.remote as { ids?: string[] }).ids)) {
            // 多端同时拖拽：本地顺序优先，远端比本地多出的任务 id 追加到末尾，不丢任一端
            const remoteIds = (result.remote as { ids: string[] }).ids
            const seen = new Set(this.todayOrder)
            this.todayOrder = [...this.todayOrder, ...remoteIds.filter((id) => !seen.has(id))]
            await idbPut('kv', todayOrderCacheKey(auth.username), { ids: this.todayOrder })
            knownEtag = result.remoteEtag ?? undefined
          } else {
            knownEtag = undefined
          }
        }
        useUiStore().toast('保存今日顺序失败：检测到其他设备持续修改，请稍后重试', 'error')
        return false
      } catch (e) {
        console.error('保存今日任务顺序到 OSS 失败', e)
        useUiStore().toast(`保存今日顺序失败：${describeOssError(e)}`, 'error')
        return false
      }
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
        // 重复任务完成：不立即生成下一次，而是把下一次出现存成模板（等重复当天再显示）。
        // 提醒邮件由服务器按周期规则继续按时发送，即使不打开 App 也会每天提醒；
        // 模板 id 沿用源任务 id，保证服务器提醒行不被打断。
        const occ = buildRepeatOccurrence(task, todayKey())
        if (occ) {
          const masters = this.repeats[task.projectId] ?? []
          if (!masters.some((m) => m.sourceTaskId === task.id)) {
            const now = nowIso()
            this.repeats[task.projectId] = [
              ...masters,
              {
                id: task.id,
                projectId: task.projectId,
                sourceTaskId: task.id,
                rootTaskId: rootIdOf(task),
                dueDate: occ.dueDate,
                template: occ.template,
                createdAt: now,
                updatedAt: now,
              },
            ]
            this._persistRepeats(task.projectId)
            logAudit('生成重复任务模板', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}，周期：${task.repeat.type}`))
          }
        }
      } else if (!completing && task.repeat) {
        // 取消完成：删除该任务的重复模板，恢复由任务自己承担提醒；
        // 服务器端同一 task_id 行的推进时间由“服务端时间较新则保留”逻辑兜底，不重复发信。
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
    softDelete(id: string) {
      const task = this.all.find((t) => t.id === id)
      if (!task) return
      task.status = task.status === 'completed' ? 'completed' : 'deleted'
      task.updatedAt = nowIso()
      this.tasks[task.projectId] = this.tasks[task.projectId].filter((t) => t.id !== id)
      this.trash[task.projectId] = mergeUnique(this.trash[task.projectId] ?? [], [task])
      this._persist(task.projectId)
      this._persistTrash(task.projectId)
      // 删除重复模板：周期提醒随任务删除一并停止（服务器同 task_id 行下次同步即移除）
      this._deleteMasterForTask(task.id)
      logAudit('删除任务', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}`))
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
      task.status = task.status === 'completed' ? 'completed' : 'pending'
      task.updatedAt = nowIso()
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
      // 恢复重复任务：删除其重复模板，由恢复后的任务自己承担后续周期，避免与模板重复生成/重复提醒
      this._deleteMasterForTask(task.id)
      logAudit('恢复任务', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}`))
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
      // 批量导入的新任务同样登记到今日顺序表末尾（仅今日可见的），跨设备顺序一致
      const today = todayKey()
      const newIds = list.filter((t) => isTaskVisibleToday(t, today)).map((t) => t.id)
      if (newIds.length) {
        this.todayOrder = [...this.todayOrder, ...newIds.filter((id) => !this.todayOrder.includes(id))]
        void this.saveTodayOrderNow()
      }
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
      }
      logAudit('永久删除任务', safeDetail(`任务ID：${id}，项目ID：${projectId}`))
    },
    /** 项目删除：全部任务（含已有回收站）并入 trash 保留，活跃列表清空 */
    markAllDeleted(projectId: string) {
      const active = this.tasks[projectId] ?? []
      const moved = active.map((t) => ({ ...t, status: t.status === 'completed' ? 'completed' as const : 'deleted' as const, updatedAt: nowIso() }))
      this.trash[projectId] = mergeUnique(this.trash[projectId] ?? [], moved)
      this.tasks[projectId] = []
      // 项目归档进回收站：其重复模板一并删除，周期提醒停止（恢复项目时任务重新承担）
      if ((this.repeats[projectId] ?? []).length) {
        this.repeats[projectId] = []
        this._persistRepeats(projectId)
      }
      this._persist(projectId)
      this._persistTrash(projectId)
    },
    /** 整项目恢复：把该项目回收站里的全部任务还原为活跃任务（状态置回 pending），
     *  并删除该项目全部回收站分片文件（含旧版 trash.json），使其从回收站扫描结果中消失 */
    async restoreProjectTasks(projectId: string) {
      const deleted = this.trash[projectId] ?? []
      // 先删物理分片（含未加载的旧月份），再清内存，避免刷新后旧分片残留
      await this.purgeTrashFiles(projectId)
      if (deleted.length) {
        const restored = deleted.map((t) => ({ ...t, status: t.status === 'completed' ? 'completed' as const : 'pending' as const, updatedAt: nowIso() }))
        // 恢复的重复任务由任务自己承担后续周期：删除其重复模板，避免与模板重复生成/重复提醒
        const ids = new Set(deleted.map((t) => t.id))
        const masters = this.repeats[projectId] ?? []
        if (masters.some((m) => ids.has(m.sourceTaskId))) {
          this.repeats[projectId] = masters.filter((m) => !ids.has(m.sourceTaskId))
          this._persistRepeats(projectId)
        }
        this.tasks[projectId] = sortActiveList(mergeUnique(this.tasks[projectId] ?? [], restored))
        this.trash[projectId] = []
        this._persist(projectId)
        this._persistTrash(projectId, true)
      }
    },
    /** 重名合并：把已删除项目的活跃+回收站任务并入同名现有项目（回收站任务还原为活跃），
     *  并删除旧项目全部回收站分片文件 */
    async mergeProjectInto(fromId: string, toId: string) {
      const active = (this.tasks[fromId] ?? []).map((t) => ({ ...t, projectId: toId }))
      const deleted = (this.trash[fromId] ?? []).map((t) => ({
        ...t,
        projectId: toId,
        status: t.status === 'completed' ? 'completed' as const : 'pending' as const,
        updatedAt: nowIso(),
      }))
      this.tasks[toId] = sortActiveList(mergeUnique(this.tasks[toId] ?? [], [...active, ...deleted]))
      this.tasks[fromId] = []
      this.trash[fromId] = []
      await this.purgeTrashFiles(fromId)
      // 重名合并：重复模板随项目一并合并到目标项目
      const fromMasters = this.repeats[fromId] ?? []
      if (fromMasters.length) {
        this.repeats[toId] = [
          ...(this.repeats[toId] ?? []),
          ...fromMasters.map((m) => ({ ...m, projectId: toId })),
        ]
        this.repeats[fromId] = []
        this._persistRepeats(toId)
        this._persistRepeats(fromId)
      }
      this._persist(toId)
      this._persist(fromId)
      this._persistTrash(fromId)
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
      const master = masters.find((m) => m.template.id === targetTaskId)
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
    /** 确认式移入回收站：立即写盘任务+回收站，成功才返回 true；失败回滚并返回 false */
    async softDeleteConfirmed(id: string): Promise<boolean> {
      const auth = useAuthStore()
      const task = this.all.find((t) => t.id === id)
      if (!task) return false
      const pid = task.projectId
      const tasksSnap = (this.tasks[pid] ?? []).slice()
      const trashSnap = (this.trash[pid] ?? []).slice()
      this.softDelete(id)
      const [okTasks, okTrash] = await Promise.all([this.saveProjectNow(pid), this.saveTrashNow(pid)])
      if (okTasks && okTrash) return true
      this.tasks[pid] = tasksSnap
      this.trash[pid] = trashSnap
      await idbPut('tasks', taskCacheKey(auth.username, pid), tasksSnap)
      await idbPut('trash', trashCacheKey(auth.username, pid), trashSnap)
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
      if (!task.repeat) {
        // 移除重复：删除模板，本次出现转为普通一次性任务
        this.repeats[pid] = masters.filter((m) => m.id !== masterId)
        this._persistRepeats(pid)
        this.upsert(task)
      } else {
        // 保留重复：统一同步逻辑（与今日任务 / 时间胶囊编辑一致），只改内存，下方统一落盘
        this._syncRepeatMasterForTask(task, { masterId })
      }
      const okTasks = !task.repeat ? await this.saveProjectNow(pid) : true
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
     * - 普通未来/今日任务走软删（入回收站）。
     */
    async deleteFutureTaskConfirmed(taskId: string, date?: string): Promise<boolean> {
      let masterPid: string | undefined
      let master: RepeatMaster | undefined
      for (const pid of Object.keys(this.repeats)) {
        const m = (this.repeats[pid] ?? []).find((x) => x.template.id === taskId)
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
      // 活跃待办重复任务的「未来重复日」单日删除：只在对应那一天生成 deleted 记录并标记已处理，
      // 绝不动今天、其它未来日与已完成历史日；date 缺省且无法确定目标日时退化为整任务软删。
      const active = this.all.find((x) => x.id === taskId)
      if (active?.repeat && active.status === 'pending' && date) {
        const rootId = rootIdOf(active)
        return await this._deleteOccurrence(taskId, date, rootId, active, active, undefined, active.projectId)
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
      // 生成单日已删除记录（入回收站，按当天分片）
      const occTime = source.reminderTime ?? source.startTime ?? source.endTime ?? `${day}T00:00:00+08:00`
      // 单日处理（入舱/删除）后，若该重复模板的 dueDate 恰好在已处理日上，立即推进到下一个未处理重复日：
      // 否则未来任务区 / 日历图会一直看不到下一次，直到下次加载/同步触发物化才推进。
      // 无剩余未处理重复日则删除模板（链条自然结束）。
      if (masterPid !== undefined) {
        const mlist = this.repeats[masterPid] ?? []
        const mi = mlist.findIndex((m) => m.template.id === source.id)
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
            mlist.splice(mi, 1)
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
      // 立即落盘全部涉及项目
      const jobs: Promise<boolean>[] = []
      if (rootActivePid) jobs.push(this.saveProjectNow(rootActivePid))
      if (masterPid) jobs.push(this.saveRepeatsNow(masterPid))
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
          const m = (this.repeats[pid] ?? []).find((x) => x.template.id === taskId)
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
      const occTime =
        source.reminderTime ?? source.startTime ?? source.endTime ?? `${day}T00:00:00+08:00`
      // 单日处理后，若该重复模板的 dueDate 恰好在已处理日上，立即推进到下一个未处理重复日：
      // 否则未来任务区 / 日历图会一直看不到下一次，直到下次加载/同步触发物化才推进
      // （即用户感受到的「要多刷新几次才更新」）。无剩余未处理重复日则删除模板（链条自然结束）。
      if (masterPid !== undefined) {
        const mlist = this.repeats[masterPid] ?? []
        const mi = mlist.findIndex((m) => m.template.id === source.id)
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
            mlist.splice(mi, 1)
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
      if (masterPid) jobs.push(this.saveRepeatsNow(masterPid))
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
      this.restore(id, toProjectId)
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
      for (const pid of affected) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
        trashSnap.set(pid, (this.trash[pid] ?? []).slice())
      }
      for (const pid of affectedRepeats) {
        repeatsSnap.set(pid, JSON.parse(JSON.stringify(this.repeats[pid] ?? [])))
      }
      const rootSnap = root ? JSON.parse(JSON.stringify(root)) : undefined
      this.permanentDelete(projectId, id)
      const jobs: Promise<boolean>[] = []
      for (const pid of affected) {
        jobs.push(this.saveProjectNow(pid))
        jobs.push(this.saveTrashNow(pid))
      }
      for (const pid of affectedRepeats) jobs.push(this.saveRepeatsNow(pid))
      const ok = (await Promise.all(jobs)).every(Boolean)
      if (ok) return true
      // 失败回滚：内存 + IDB（根任务对象被原地改过，需用深拷贝还原）
      if (root && rootSnap) Object.assign(root, rootSnap)
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
      saveDebouncers.clear()
      trashDebouncers.clear()
      tasksSaving.clear()
      trashSaving.clear()
      repeatsSaving.clear()
      toggleSaving.clear()
      occurrenceSaving.clear()
      if (syncReminderTimer) {
        window.clearTimeout(syncReminderTimer)
        syncReminderTimer = undefined
      }
      this.tasks = {}
      this.trash = {}
      this.repeats = {}
      this.loadedProjects = []
      this.trashLoaded = []
      this.trashLoadedMonths = {}
      this.trashShardMonths = {}
      this.trashHasMore = {}
      this.trashLoadedYears = []
      this.trashYear = null
      this.repeatsLoaded = []
      this.todayOrder = []
      // 清空固定集与 LRU 顺序，避免跨账号残留导致新账号项目无法逐出
      viewPins.clear()
      capsulePins.clear()
      accessOrder.length = 0
      evicting = false
    },
  },
})
