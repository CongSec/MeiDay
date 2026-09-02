import { defineStore } from 'pinia'
import type { OssClient } from '@/utils/oss'
import { useAuthStore } from './auth'
import { useUiStore } from './ui'
import { useStatsStore } from './stats'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { applyDeletedTombstones, compareAndSwapPut, filterTasksForProject, mergeDeletedTombstones, mergeTasks, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbGet, idbPut, idbDel } from '@/utils/idb'
import { debounce, type Debounced } from '@/utils/debounce'
import { queueSyncChange } from '@/utils/syncReport'
import { dateKeyOf, diffDaysKey, nowIso, todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { buildReminderPayload, buildRepeatOccurrence, nextRepeatDate, shiftTaskTimes } from '@/utils/repeat'
import { api } from '@/api/client'
import { logAudit, safeDetail } from '@/utils/audit'
import { UNCATEGORIZED, type AttachmentMeta, type RepeatMaster, type Subtask, type Task } from '@/types'
import { newSubtask, normalizeTask, normalizeTasks, pendingSubtaskReminders } from '@/utils/task'
import { deleteAttachments } from '@/utils/attachments'
const saveDebouncers = new Map<string, Debounced<[]>>()
const trashDebouncers = new Map<string, Debounced<[]>>()
// 每项目在途保存 Promise：确认式保存/即时保存共用，串行化同一文件的写入，
// 避免同一文件并发 CAS 写互相覆盖或误报“冲突合并”提示
const tasksSaving = new Map<string, Promise<boolean>>()
const trashSaving = new Map<string, Promise<boolean>>()
const repeatsSaving = new Map<string, Promise<boolean>>()
const toggleSaving = new Set<string>()
/** 正在进行中的保存（含防抖触发的保存执行中）：期间禁止逐出该项目，避免 OSS 写一半被清内存 */
const savingNow = new Set<string>()
/** 内存常驻项目上限：超过上限的“最近最少使用”非固定项目会被逐出（仅内存，IDB 缓存保留，下次访问按需重载） */
const MAX_RESIDENT_PROJECTS = 10
/** 固定保留项目（不参与逐出）：
 *  - viewPins：当前视图聚焦的项目（正在浏览的项目 / 回收站展开的项目），由视图挂载/卸载时增删；
 *  - 今日相关项目：逐出时实时计算「内存里存在今日可见任务的项目」，保证今日视图/侧栏角标依赖的
 *    项目常驻（不随 profile 全量固定，否则几百个项目会把所有访问过的项目都钉在内存里，LRU 失效）。 */
const viewPins = new Set<string>()
/** LRU 访问顺序：越靠前越最近使用（项目加载/访问/写入时置顶） */
const accessOrder: string[] = []
/** 逐出互斥：防止并发 touch 触发多次逐出循环 */
let evicting = false
let syncReminderTimer: number | undefined
/** 项目加载的 in-flight Promise：ProjectView 的 onMounted 与路由 watch 会同时调用
 *  loadProject，复用同一个请求避免打开项目时重复下载该项目的 tasks/repeats 数据包。 */
const loadingProjectPromises = new Map<string, Promise<void>>()
/** 未分类任务存 today.json，分类任务存 projects/{pid}/tasks.json */
function tasksFilePath(username: string, projectId: string): string {
  return projectId === UNCATEGORIZED ? paths.today(username) : paths.tasks(username, projectId)
}
/** 未分类回收站存 today_trash.json，分类回收站存 projects/{pid}/trash.json */
function trashFilePath(username: string, projectId: string): string {
  return projectId === UNCATEGORIZED ? paths.todayTrash(username) : paths.trash(username, projectId)
}
/** IDB 缓存键：任务/回收站均按 用户名 + 项目ID 命名，避免跨账号残留脏数据 */
function taskCacheKey(username: string, projectId: string): string {
  return `tasks:${username}:${projectId}`
}
function trashCacheKey(username: string, projectId: string): string {
  return `trash:${username}:${projectId}`
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
 * 让手动拖拽顺序在加载/同步合并后保持；从未拖拽过的项目退化为按截止时间升序（旧行为）。
 */
function sortActiveList(list: Task[]): Task[] {
  const hasSort = list.some((t) => t.sort !== undefined)
  const cmp = hasSort
    ? (a: Task, b: Task) => {
        const sa = a.sort ?? Number.MAX_SAFE_INTEGER
        const sb = b.sort ?? Number.MAX_SAFE_INTEGER
        return sa !== sb ? sa - sb : (a.endTime || '').localeCompare(b.endTime || '')
      }
    : (a: Task, b: Task) => (a.endTime || '').localeCompare(b.endTime || '')
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
/** 拉取远端回收站文件；文件不存在时视为空，网络/权限错误向上抛。
 *  带 ETag 条件 GET：远端未变化返回 304 时直接复用本地缓存，避免每次同步都全量
 *  下载 trash.json（回收站随任务归档不断变大，登录/轮询时全量拉取非常浪费）。 */
async function fetchRemoteTrash(client: OssClient, username: string, projectId: string): Promise<Task[]> {
  const etagKey = `etag:${username}:${projectId}:trash`
  const cacheKey = trashCacheKey(username, projectId)
  const etag = await idbGet<string>('kv', etagKey)
  try {
    const res = await client.get(
      trashFilePath(username, projectId),
      etag ? { headers: { 'If-None-Match': etag } } : undefined,
    )
    if (res.res.status === 304) {
      // 远端未变化：复用本地回收站缓存（无缓存视为空）
      const cached = await idbGet<Task[]>('trash', cacheKey)
      return cached ?? []
    }
    if (res.res.status === 404) {
      await idbDel('kv', etagKey)
      return []
    }
    const list = JSON.parse(res.content.toString()) as Task[]
    normalizeTasks(list)
    const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
    if (newEtag) await idbPut('kv', etagKey, newEtag)
    await idbPut('trash', cacheKey, list)
    return list
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') {
      await idbDel('kv', etagKey)
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
    /** 今日相关项目：本地（IDB）缓存里存在“今日可见”任务的项目。
     *  登录/全量同步时只刷这些，其余项目打开时再由 loadProject 按需从 OSS 拉取。 */
    todayRelevantProjectIds: (s) => (projectIds: string[]) => {
      const today = todayKey()
      const set = new Set<string>()
      for (const id of projectIds) {
        if ((s.tasks[id] ?? []).some((t) => isTaskVisibleToday(t, today))) set.add(id)
      }
      return [...set]
    },
    /** 当前视图聚焦的项目 id（正在浏览的项目 / 回收站展开的项目），供手动同步一并刷新 */
    viewPinnedProjectIds: (s) => [...viewPins],
  },
  actions: {
    async loadProject(projectId: string) {
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
        const cachedActive = filterStaleAcrossProjects(
          this.tasks,
          projectId,
          filterTasksForProject(active, projectId),
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
      try {
        const client = await createOssClient(auth.creds)
        const etag = await idbGet<string>('kv', `etag:${auth.username}:${projectId}`)
        const res = await client.get(
          tasksFilePath(auth.username, projectId),
          etag ? { headers: { 'If-None-Match': etag } } : undefined,
        )
        if (res.res.status !== 304) {
                  const remote = JSON.parse(res.content.toString()) as Task[]
          normalizeTasks(remote)
          const { active, deleted } = splitDeleted(remote)
          this.tasks[projectId] = sortActiveList(
            filterStaleAcrossProjects(
              this.tasks,
              projectId,
              filterTasksForProject(active, projectId),
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
          if (newEtag) await idbPut('kv', `etag:${auth.username}:${projectId}`, newEtag)
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
          await idbDel('kv', `etag:${auth.username}:${projectId}`)
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
        const etag = await idbGet<string>('kv', todayOrderEtagKey(auth.username))
        const res = await client.get(
          todayOrderFilePath(auth.username),
          etag ? { headers: { 'If-None-Match': etag } } : undefined,
        )
        if (res.res.status === 304) return
        const remote = JSON.parse(res.content.toString()) as { ids?: string[] }
        const ids = Array.isArray(remote?.ids) ? remote.ids : []
        this.todayOrder = ids
        await idbPut('kv', cacheKey, { ids })
        const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
        if (newEtag) await idbPut('kv', todayOrderEtagKey(auth.username), newEtag)
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
    /** 把“最近最少使用”的非固定项目逐出内存（仅内存与已加载标记；IDB 缓存保留，下次访问按需重载）。
     *  正在保存 / 有未落盘待发变更的项目不逐出，避免把内存数据写空到 OSS。 */
    async evictIfNeeded() {
      if (evicting || accessOrder.length <= MAX_RESIDENT_PROJECTS) return
      evicting = true
      try {
        const today = todayKey()
        const pins = new Set<string>([...viewPins, UNCATEGORIZED])
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
      this.repeatsLoaded = this.repeatsLoaded.filter((x) => x !== projectId)
    },
    /** 拉取回收站任务（独立文件，按需加载） */
    async loadTrash(projectId: string) {
      this.touchProject(projectId)
      const auth = useAuthStore()
      if (this.trashLoaded.includes(projectId)) return
      const cached = await idbGet<Task[]>('trash', trashCacheKey(auth.username, projectId))
      if (cached) {
        normalizeTasks(cached)
        this.trash[projectId] = cached
      }
      if (!auth.creds) return
      try {
        const client = await createOssClient(auth.creds)
        const etag = await idbGet<string>('kv', `etag:${auth.username}:${projectId}:trash`)
        const res = await client.get(
          trashFilePath(auth.username, projectId),
          etag ? { headers: { 'If-None-Match': etag } } : undefined,
        )
        if (res.res.status !== 304) {
                  const remote = JSON.parse(res.content.toString()) as Task[]
          normalizeTasks(remote)
          this.trash[projectId] = remote
          await idbPut('trash', trashCacheKey(auth.username, projectId), remote)
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', `etag:${auth.username}:${projectId}:trash`, newEtag)
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
          await idbDel('kv', `etag:${auth.username}:${projectId}:trash`)
        } else {
          throw new Error(await enrichOssError(e))
        }
      }
      this.trashLoaded.push(projectId)
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
              if (obj.name.endsWith('/trash.json')) {
                const seg = obj.name.split('/')
                const pid = seg[seg.length - 2]
                ids.add(pid)
                if (obj.lastModified) latestByProject[pid] = String(obj.lastModified)
              } else if (obj.name.endsWith('/today_trash.json')) {
                hasUncategorized = true
                if (obj.lastModified) latestByProject[UNCATEGORIZED] = String(obj.lastModified)
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
      this.touchProject(projectId)
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = await createOssClient(auth.creds)
      const key = tasksFilePath(auth.username, projectId)
      // 条件 GET：带本地 ETag（If-None-Match），远端未变化时返回 304，避免全量下载
      const etag = await idbGet<string>('kv', `etag:${auth.username}:${projectId}`)
      const res = await client.get(
        key,
        etag ? { headers: { 'If-None-Match': etag } } : undefined,
      )
      if (res.res.status === 304) return // 远端未变化（ETag 命中），无需下载/合并
      const remote = JSON.parse(res.content.toString()) as Task[]
      normalizeTasks(remote)
      const { active: rawRemoteActive, deleted: remoteDeleted } = splitDeleted(remote)
      // 丢弃任务文件里 projectId 与所在项目不一致的过期副本（跨项目移动残留），
      // 并跨项目去重（其它已加载项目里有更新的同 id 副本时本份视为过期），
      // 防止轮询合并把已移走的任务“复活”回源项目（BUG：移动任务被复制一份）
      const remoteActive = filterStaleAcrossProjects(
        this.tasks,
        projectId,
        filterTasksForProject(rawRemoteActive, projectId),
      )
      const local = filterStaleAcrossProjects(
        this.tasks,
        projectId,
        filterTasksForProject(this.tasks[projectId] ?? [], projectId),
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
      if (newEtag) await idbPut('kv', `etag:${auth.username}:${projectId}`, newEtag)
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
      savingNow.add(projectId)
      try {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      // 使用快照，避免登出/重置竞态下读到被清空的 store
      let list = (snapshot ?? this.tasks[projectId] ?? []).slice()
      const key = tasksFilePath(auth.username, projectId)
      const etagKey = `etag:${auth.username}:${projectId}`
      let knownEtag = await idbGet<string>('kv', etagKey)
      try {
      // CAS 写入 + 冲突合并：最多重试 3 次，防止多端同时编辑互相覆盖（丢失更新）
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<Task[]>(client, key, list, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
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
          const filteredRemote = filterStaleAcrossProjects(
            this.tasks,
            projectId,
            filterTasksForProject(remoteActive, projectId),
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
    async saveTrash(projectId: string, snapshot?: Task[]): Promise<boolean> {
      savingNow.add(projectId)
      try {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      let list = (snapshot ?? this.trash[projectId] ?? []).slice()
      const key = trashFilePath(auth.username, projectId)
      const etagKey = `etag:${auth.username}:${projectId}:trash`
      let knownEtag = await idbGet<string>('kv', etagKey)
      try {
      // CAS 写入 + 冲突合并：最多重试 3 次，防止多端同时编辑回收站互相覆盖
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<Task[]>(client, key, list, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          await idbPut('trash', trashCacheKey(auth.username, projectId), list)
            queueSyncChange(auth.username, 'trash', projectId)
          if (attempt > 0) useUiStore().toast('检测到其他设备同时修改回收站，已自动合并', 'ok')
          return true
        }
        if (result.remote) {
          const remoteList = [...(result.remote as Task[])]
          normalizeTasks(remoteList)
          list = mergeTasks(list, remoteList)
          knownEtag = result.remoteEtag ?? undefined
          if (!snapshot) {
            this.trash[projectId] = list
            await idbPut('trash', trashCacheKey(auth.username, projectId), list)
          }
        } else {
          knownEtag = undefined
        }
      }
      useUiStore().toast('保存回收站失败：检测到其他设备持续修改，请稍后重试', 'error')
      return false
      } catch (e) {
        console.error('保存回收站到 OSS 失败', e)
        useUiStore().toast(`保存回收站失败：${describeOssError(e)}`, 'error')
        return false
      }
      } finally {
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
      try {
        const client = await createOssClient(auth.creds)
        const etag = await idbGet<string>('kv', `etag:${auth.username}:${projectId}:repeats`)
        const res = await client.get(
          repeatsFilePath(auth.username, projectId),
          etag ? { headers: { 'If-None-Match': etag } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as RepeatMaster[]
          this.repeats[projectId] = remote ?? []
          await idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId])
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', `etag:${auth.username}:${projectId}:repeats`, newEtag)
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
          await idbDel('kv', `etag:${auth.username}:${projectId}:repeats`)
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
          const template = shiftTaskTimes(master.template, diffDaysKey(master.dueDate, dueDate))
          toAdd.push({
            ...template,
            id: crypto.randomUUID(),
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
    /** 编辑源任务后同步重复模板：保持后续周期属性一致；移除重复则删除模板（周期提醒停止） */
    _syncRepeatMasterForTask(task: Task) {
      for (const pid of Object.keys(this.repeats)) {
        const masters = this.repeats[pid] ?? []
        const idx = masters.findIndex((m) => m.sourceTaskId === task.id)
        if (idx < 0) continue
        if (!task.repeat) {
          // 重复规则被移除：删除模板（源任务若仍有一次性提醒，由 syncReminders 注册）
          this.repeats[pid] = masters.filter((m) => m.id !== masters[idx].id)
          this._persistRepeats(pid)
          return
        }
        const occ = buildRepeatOccurrence(task, todayKey())
        if (!occ) {
          this.repeats[pid] = masters.filter((m) => m.id !== masters[idx].id)
          this._persistRepeats(pid)
          return
        }
        this.repeats[pid] = [...masters]
        this.repeats[pid][idx] = {
          ...masters[idx],
          projectId: task.projectId,
          dueDate: occ.dueDate,
          template: occ.template,
          updatedAt: nowIso(),
        }
        this._persistRepeats(pid)
        return
      }
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
      // 新任务/跨项目移入：清掉旧项目的 sort，避免按其旧位置插入（新任务由 sortActiveList 补到末尾）
      if (isNew) task.sort = undefined
      // 新任务若是今日可见，登记到今日顺序表末尾（独立小文件后台落盘，失败不影响主保存），
      // 保证今日视图里新任务的位置跨设备一致，而不是每次按截止时间重排
      if (isNew && isTaskVisibleToday(task, todayKey())) {
        this.todayOrder = [...this.todayOrder.filter((id) => id !== task.id), task.id]
        void this.saveTodayOrderNow()
      }
      if (idx >= 0) Object.assign(list[idx], task)
      else list.push(task)
      // README：恢复/增删时按截止时间补位；仅新插入/移动项目时重排，避免覆盖拖拽手动顺序
      this.tasks[target] = isNew ? sortActiveList(list) : list
      this._persist(target)
      // 编辑源任务后同步重复模板：保持后续周期属性一致；移除重复则删除模板（周期提醒随之停止）
      this._syncRepeatMasterForTask(task)
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
      task.updatedAt = nowIso()
      this._persist(task.projectId)
      if (applyStats) {
        // 累计完成任务统计（存用户 OSS，绝不清零/重算）：完成 +1，取消完成 -1
        useStatsStore().addDelta(completing ? 1 : -1, task.id)
      }
      logAudit(completing ? '完成任务' : '取消完成', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}`))
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
        const completing = this._flipComplete(id, false)
        const okTasks = await this.saveProjectNow(pid)
        const repeatsChanged = !!task.repeat && JSON.stringify(this.repeats[pid]) !== JSON.stringify(repeatsSnap)
        const okRepeats = repeatsChanged ? await this.saveRepeatsNow(pid) : true
        if (okTasks && okRepeats) {
          await useStatsStore().addDelta(completing ? 1 : -1, task.id)
          return true
        }
        // 失败回滚：恢复任务与重复模板（内存 + IDB），避免缓存残留未保存的改动
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
      sub.updatedAt = nowIso()
      task.updatedAt = nowIso()
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
    /** 整项目恢复：把该项目回收站里的全部任务还原为活跃任务（状态置回 pending） */
    restoreProjectTasks(projectId: string) {
      const deleted = this.trash[projectId] ?? []
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
    /** 重名合并：把已删除项目的活跃+回收站任务并入同名现有项目（回收站任务还原为活跃），并清空旧项目数据 */
    mergeProjectInto(fromId: string, toId: string) {
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
      for (const pid of touchPids) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
        repeatsSnap.set(pid, (this.repeats[pid] ?? []).slice())
      }
      this.upsert(task)
      const results = await Promise.all([...touchPids].map((pid) => this.saveProjectNow(pid)))
      if (results.every(Boolean)) return true
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
     * - 保留重复规则：只更新 repeats 中的模板内容并重算下一次出现日期，不落入主任务列表；
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
      const master = masters[idx]
      if (!task.repeat) {
        // 移除重复：删除模板，本次出现转为普通一次性任务
        this.repeats[pid] = masters.filter((m) => m.id !== masterId)
        this._persistRepeats(pid)
        this.upsert(task)
      } else {
        const dueDate = task.reminderTime || task.startTime || task.endTime
          ? dateKeyOf(task.reminderTime || task.startTime || task.endTime)
          : master.dueDate
        const next = [...masters]
        next[idx] = { ...master, template: task, dueDate, updatedAt: nowIso() }
        this.repeats[pid] = next
        this._persistRepeats(pid)
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
     * 删除“未来任务”：
     * - 若 id 是重复模板（repeats 中 master.template.id），软删其源任务（入回收站），
     *   重复模板与周期提醒随之停止；源任务异常缺失时仅删除该未来出现模板；
     * - 普通未来/今日任务走软删（入回收站）。
     */
    async deleteFutureTaskConfirmed(taskId: string): Promise<boolean> {
      for (const pid of Object.keys(this.repeats)) {
        const masters = this.repeats[pid] ?? []
        const m = masters.find((x) => x.template.id === taskId)
        if (!m) continue
        const src = this.all.find((x) => x.id === m.id)
        if (src) return this.softDeleteConfirmed(src.id)
        // 源任务不在主列表（异常兜底）：仅删除该未来出现模板
        const auth = useAuthStore()
        const repeatsSnap = (this.repeats[pid] ?? []).slice()
        this.repeats[pid] = masters.filter((x) => x.id !== m.id)
        this._persistRepeats(pid)
        const ok = await this.saveRepeatsNow(pid)
        if (ok) return true
        this.repeats[pid] = repeatsSnap
        await idbPut('repeats', repeatsCacheKey(auth.username, pid), repeatsSnap)
        return false
      }
      return this.softDeleteConfirmed(taskId)
    },

    /** 确认式恢复任务：跨项目时同时保存新旧项目，成功才返回 true；失败回滚并返回 false */
    async restoreConfirmed(id: string, toProjectId?: string): Promise<boolean> {
      const auth = useAuthStore()
      let sourcePid: string | undefined
      for (const [pid, list] of Object.entries(this.trash)) {
        if (list.some((t) => t.id === id)) {
          sourcePid = pid
          break
        }
      }
      if (sourcePid === undefined) {
        for (const [pid, list] of Object.entries(this.tasks)) {
          if (list.some((t) => t.id === id)) {
            sourcePid = pid
            break
          }
        }
      }
      if (sourcePid === undefined) return false
      const targetPid = toProjectId ?? sourcePid
      const tasksSnap = new Map<string, Task[]>()
      const trashSnap = new Map<string, Task[]>()
      for (const pid of new Set([sourcePid, targetPid])) {
        tasksSnap.set(pid, (this.tasks[pid] ?? []).slice())
        trashSnap.set(pid, (this.trash[pid] ?? []).slice())
      }
      this.restore(id, toProjectId)
      const okTarget = await this.saveProjectNow(targetPid)
      const okSource = sourcePid === targetPid ? true : await this.saveProjectNow(sourcePid)
      const okTrash = await this.saveTrashNow(sourcePid)
      if (okTarget && okSource && okTrash) return true
      for (const [pid, list] of tasksSnap) {
        this.tasks[pid] = list
        await idbPut('tasks', taskCacheKey(auth.username, pid), list)
      }
      for (const [pid, list] of trashSnap) {
        this.trash[pid] = list
        await idbPut('trash', trashCacheKey(auth.username, pid), list)
      }
      return false
    },
    /** 确认式永久删除：立即写盘任务+回收站，成功才返回 true；失败回滚并返回 false */
    async permanentDeleteConfirmed(projectId: string, id: string): Promise<boolean> {
      const auth = useAuthStore()
      const tasksSnap = (this.tasks[projectId] ?? []).slice()
      const trashSnap = (this.trash[projectId] ?? []).slice()
      const repeatsSnap = (this.repeats[projectId] ?? []).slice()
      this.permanentDelete(projectId, id)
      const [okTasks, okTrash] = await Promise.all([this.saveProjectNow(projectId), this.saveTrashNow(projectId)])
      if (okTasks && okTrash) return true
      this.tasks[projectId] = tasksSnap
      this.trash[projectId] = trashSnap
      this.repeats[projectId] = repeatsSnap
      await idbPut('tasks', taskCacheKey(auth.username, projectId), tasksSnap)
      await idbPut('trash', trashCacheKey(auth.username, projectId), trashSnap)
      await idbPut('repeats', repeatsCacheKey(auth.username, projectId), repeatsSnap)
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
      if (syncReminderTimer) {
        window.clearTimeout(syncReminderTimer)
        syncReminderTimer = undefined
      }
      this.tasks = {}
      this.trash = {}
      this.repeats = {}
      this.loadedProjects = []
      this.trashLoaded = []
      this.repeatsLoaded = []
      this.todayOrder = []
      // 清空固定集与 LRU 顺序，避免跨账号残留导致新账号项目无法逐出
      viewPins.clear()
      accessOrder.length = 0
      evicting = false
    },
  },
})