import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { createOssClient, paths, type OssClient } from '@/utils/oss'
import { applyDeletedTombstones, lastModifiedOf, lmKeyOf, mergeDeletedTombstones, versionToken } from '@/utils/sync'
import { idbGet, idbPut, idbDel } from '@/utils/idb'
import { nowIso, todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { normalizeTasks, taskEffectiveEndTime } from '@/utils/task'
import { addDaysKey, dateKeyOf } from '@/utils/time'
import { UNCATEGORIZED, type RepeatMaster, type Task } from '@/types'

/**
 * 桌面小组件的精简版 tasks store —— 完全只读。
 *
 * 只覆盖今日视图需要的最小功能集：
 *  - 拉取项目任务 / 今日跨项目顺序表 / 重复模板（loadProject / syncProject /
 *    loadTodayOrder / loadRepeats），全部只读 OSS，绝不写回；
 *  - 数据只进内存与本地 IDB 缓存，不调用任何 OSS PUT，也不上报同步变更；
 *  - 重复任务到期不再由小组件物化写盘，只展示 App/网页端物化后同步过来的结果。
 *
 * 为什么必须只读（BUG 根因）：
 *  旧版 syncProject 会把“合并结果与远端不一致”时写回 OSS，而合并是
 *  mergeTasks(local, remote)——任务只在一侧出现就保留。跨项目移动任务后，
 *  源项目远端文件已无该任务，但本地缓存仍残留旧副本，合并后写回就把旧副本
 *  复活进源项目文件，造成同 id 任务同时存在于两个项目，小组件显示两份重复任务。
 *  因此这里同步一律以远端为权威，不并入本地缓存，也不写回。
 *
 * 刻意省略：回收站分片、LRU 逐出、子任务编辑、时间胶囊，以及一切写操作
 * （完成/取消、排序、物化）——桌面小组件是纯展示端。
 * IDB 使用与主应用完全相同的库名/仓库/缓存键，因此主应用已缓存的数据可直接复用。
 */

function taskCacheKey(username: string, projectId: string): string {
  return `tasks:${username}:${projectId}`
}
function repeatsCacheKey(username: string, projectId: string): string {
  return `repeats:${username}:${projectId}`
}
function todayOrderFilePath(username: string): string {
  return paths.todayOrder(username)
}
function todayOrderCacheKey(username: string): string {
  return `todayOrder:${username}`
}
function todayOrderEtagKey(username: string): string {
  return `etag:${username}:today_order`
}
/** 回收站 IDB 缓存键：真实项目带月份后缀（trash:user:pid:YYYY-MM），未分类沿用单键（与主应用一致） */
function trashCacheKey(username: string, projectId: string, month?: string): string {
  return `trash:${username}:${projectId}${month ? `:${month}` : ''}`
}

/** 未分类回收站存 today_trash.json（单文件不分片）；真实项目回收站按月分片存 trash/{YYYY-MM}.json */
function trashFilePath(username: string, projectId: string, month?: string): string {
  return projectId === UNCATEGORIZED
    ? paths.todayTrash(username)
    : month
      ? paths.trashShard(username, projectId, month)
      : paths.trash(username, projectId)
}

/** 当前月份键（YYYY-MM） */
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

/** 按 id 去重合并两个任务列表（保序：base 在前，incoming 补充新增） */
function mergeUnique(base: Task[], incoming: Task[]): Task[] {
  const seen = new Set(base.map((t) => t.id))
  return [...base, ...incoming.filter((t) => !seen.has(t.id))]
}

/** 拉取远端单个回收站文件（真实项目某月分片 / 未分类单文件）；文件不存在时视为空，网络/权限错误向上抛。
 *  带 Last-Modified 条件 GET（If-Modified-Since）：远端未变化返回 304 时直接复用本地缓存，
 *  避免每次同步都全量下载（回收站按月分片后日常只碰当月 + 上月两个小文件）。 */
async function fetchRemoteTrashShard(
  client: OssClient,
  username: string,
  projectId: string,
  month?: string,
): Promise<Task[]> {
  const etagKey = `etag:${username}:${projectId}:trash${month ? `:${month}` : ''}`
  const lmKey = lmKeyOf(etagKey)
  const cacheKey = trashCacheKey(username, projectId, month)
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
    // 部分 S3 兼容服务对 304 会抛异常而非正常返回：与主应用一致地兜底
    if (err.code === 304 || err.status === 304) {
      const cached = await idbGet<Task[]>('trash', cacheKey)
      return cached ?? []
    }
    throw e
  }
}

/** 回收站墓碑合并窗口：未分类拉单文件；真实项目拉当月 + 上月分片合并（与主应用一致），
 *  更早分片不参与同步，避免回收站历史增长拖慢日常操作。 */
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

function isServerEmptyError(e: unknown): boolean {
  const err = e as { code?: string | number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket'
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

function splitDeleted(list: Task[]): { active: Task[]; deleted: Task[] } {
  const active: Task[] = []
  const deleted: Task[] = []
  for (const t of list) {
    if (t.status === 'deleted') deleted.push(t)
    else active.push(t)
  }
  return { active, deleted }
}

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: {} as Record<string, Task[]>,
    repeats: {} as Record<string, RepeatMaster[]>,
    loadedProjects: [] as string[],
    repeatsLoaded: [] as string[],
    todayOrder: [] as string[],
  }),
  getters: {
    /** 全部已加载任务，按 id 去重（保留 updatedAt 最新的一份）。
     *  跨项目移动任务后，本地缓存可能同时残留新旧两个项目里的同 id 副本，
     *  若不按 id 去重，同一个任务会被渲染两遍（BUG：小组件显示重复任务）。 */
    all: (s) => {
      const byId = new Map<string, Task>()
      for (const list of Object.values(s.tasks)) {
        for (const t of list) {
          const cur = byId.get(t.id)
          if (!cur || (t.updatedAt || '').localeCompare(cur.updatedAt || '') > 0) byId.set(t.id, t)
        }
      }
      return [...byId.values()]
    },
    byProject: (s) => (projectId: string) => s.tasks[projectId] ?? [],
    todayRelevantProjectIds: (s) => (projectIds: string[]) => {
      const today = todayKey()
      const set = new Set<string>()
      for (const id of projectIds) {
        if ((s.tasks[id] ?? []).some((t) => isTaskVisibleToday(t, today))) set.add(id)
        const last = addDaysKey(today, 30)
        if ((s.repeats[id] ?? []).some((m) => m.dueDate <= last)) set.add(id)
      }
      return [...set]
    },
  },
  actions: {
    /** 加载单个项目任务：本地 IDB 缓存 + 条件 GET OSS 合并（与主应用键一致，可共享缓存）。 */
    async loadProject(projectId: string) {
      if (projectId === UNCATEGORIZED) return
      if (this.loadedProjects.includes(projectId)) return
      const auth = useAuthStore()
      const cached = await idbGet<Task[]>('tasks', taskCacheKey(auth.username, projectId))
      if (cached) {
        normalizeTasks(cached)
        this.tasks[projectId] = sortActiveList(cached.filter((t) => t.status !== 'deleted'))
        await idbPut('tasks', taskCacheKey(auth.username, projectId), this.tasks[projectId])
      }
      if (!auth.creds) {
        this.loadedProjects = [...new Set([...this.loadedProjects, projectId])]
        return
      }
      const etagKey = `etag:${auth.username}:${projectId}`
      const lmKey = lmKeyOf(etagKey)
      try {
        const client = await createOssClient(auth.creds)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          paths.tasks(auth.username, projectId),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as Task[]
          normalizeTasks(remote)
          const { active, deleted } = splitDeleted(remote)
          const activeFiltered = active.filter((t) => !t.projectId || t.projectId === projectId)
          const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
          const tombstones = mergeDeletedTombstones([], deleted, remoteTrash)
          // 只读客户端：远端即权威，不并入本地缓存（本地无任何独立改动）。
          // 旧实现 mergeTasks(local, activeFiltered) 会把“只在一侧出现”的旧副本
          // 保留下来，导致移走任务后源项目缓存残留旧副本，界面显示重复任务。
          const merged = sortActiveList(applyDeletedTombstones(activeFiltered, tombstones))
          this.tasks[projectId] = merged
          await idbPut('tasks', taskCacheKey(auth.username, projectId), merged)
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', etagKey, newEtag)
          const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
          if (newLm) await idbPut('kv', lmKey, newLm)
        } else {
          // 活跃任务文件未变化：仍尝试用远端回收站墓碑剔除已入时间胶囊/已软删任务，
          // 避免冷启动时从本地 IDB 缓存里把已入舱任务“复活”出来。
          const trash = await fetchRemoteTrash(client, auth.username, projectId)
          if (trash.length) {
            const pruned = sortActiveList(
              applyDeletedTombstones(this.tasks[projectId] ?? [], mergeDeletedTombstones([], trash, [])),
            )
            if (JSON.stringify(pruned) !== JSON.stringify(this.tasks[projectId] ?? [])) {
              this.tasks[projectId] = pruned
              await idbPut('tasks', taskCacheKey(auth.username, projectId), pruned)
            }
          }
        }
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        if (isServerEmptyError(e) || err.status === 404 || err.code === 304 || err.status === 304) {
          // 远端文件不存在：保留本地数据，不视为错误
        } else {
          throw e
        }
      }
      this.loadedProjects = [...new Set([...this.loadedProjects, projectId])]
    },
    /** 返回 IDB 中已存在任务缓存的项目 id（用于判断本地缓存是否完整） */
    async loadFromIdb(projectIds: string[]): Promise<string[]> {
      const auth = useAuthStore()
      const out: string[] = []
      for (const id of projectIds) {
        const cached = await idbGet<Task[]>('tasks', taskCacheKey(auth.username, id))
        if (Array.isArray(cached) && cached.length) out.push(id)
      }
      return out
    },
    /** 渐进分批加载所有项目（全新设备/首登时用） */
    async loadAllProgressive(projectIds: string[]) {
      const BATCH = 4
      for (let i = 0; i < projectIds.length; i += BATCH) {
        await Promise.all(projectIds.slice(i, i + BATCH).map((id) => this.loadProject(id)))
      }
    },
    /** 加载今日任务跨项目顺序表 */
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
        if (isServerEmptyError(e) || err.code === 304 || err.status === 304) return
        console.error('加载今日任务顺序失败', e)
      }
    },
    /** 拉取单个项目：从 OSS 重拉任务（远端即权威，只读不写回）；远端文件不存在时静默保留本地。 */
    async syncProject(projectId: string) {
      if (projectId === UNCATEGORIZED) return
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = await createOssClient(auth.creds)
      const etagKey = `etag:${auth.username}:${projectId}`
      const lmKey = lmKeyOf(etagKey)
      const lm = await idbGet<string>('kv', lmKey)
      const res = await client.get(
        paths.tasks(auth.username, projectId),
        lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
      )
      if (res.res.status === 304) {
        // 活跃任务文件未变化：仍尝试用远端回收站墓碑剔除已入时间胶囊/已软删任务
        // （时间胶囊操作可能只改了 trash 分片，任务不消失的 BUG 根源就在这）。
        const trash = await fetchRemoteTrash(client, auth.username, projectId)
        if (trash.length) {
          const pruned = sortActiveList(
            applyDeletedTombstones(this.tasks[projectId] ?? [], mergeDeletedTombstones([], trash, [])),
          )
          if (JSON.stringify(pruned) !== JSON.stringify(this.tasks[projectId] ?? [])) {
            this.tasks[projectId] = pruned
            await idbPut('tasks', taskCacheKey(auth.username, projectId), pruned)
          }
        }
        return
      }
      const remote = JSON.parse(res.content.toString()) as Task[]
      normalizeTasks(remote)
      const { active, deleted } = splitDeleted(remote)
      const remoteActive = active.filter((t) => !t.projectId || t.projectId === projectId)
      const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
      const tombstones = mergeDeletedTombstones([], deleted, remoteTrash)
      // 只读客户端：远端即权威，不并入本地缓存，也绝不把合并结果写回 OSS（方案 A）。
      // 旧实现 mergeTasks(local, remoteActive) 会保留本地缓存里“已移走任务”的旧副本
      // （任务只在一侧出现就保留），并在“合并结果与远端不一致”时自动写回，
      // 把旧副本复活进源项目 OSS 文件，造成同 id 任务同时存在两个项目里，
      // 小组件显示两份重复任务——这就是修改任务分类后出现重复的根因。
      const merged = sortActiveList(applyDeletedTombstones(remoteActive, tombstones))
      this.tasks[projectId] = merged
      await idbPut('tasks', taskCacheKey(auth.username, projectId), merged)
      const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
      if (newEtag) await idbPut('kv', etagKey, newEtag)
      const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
      if (newLm) await idbPut('kv', lmKey, newLm)
      if (!this.loadedProjects.includes(projectId)) {
        this.loadedProjects = [...this.loadedProjects, projectId]
      }
    },
    /** 拉取重复模板（独立文件，按需加载） */
    async loadRepeats(projectId: string) {
      const auth = useAuthStore()
      if (this.repeatsLoaded.includes(projectId)) return
      const cached = await idbGet<RepeatMaster[]>('repeats', repeatsCacheKey(auth.username, projectId))
      if (cached) this.repeats[projectId] = cached
      if (!auth.creds) {
        this.repeatsLoaded = [...new Set([...this.repeatsLoaded, projectId])]
        return
      }
      const etagKey = `etag:${auth.username}:${projectId}:repeats`
      const lmKey = lmKeyOf(etagKey)
      try {
        const client = await createOssClient(auth.creds)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          paths.repeats(auth.username, projectId),
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
        if (isServerEmptyError(e)) {
          this.repeats[projectId] = []
          await idbDel('repeats', repeatsCacheKey(auth.username, projectId))
          await idbDel('kv', etagKey)
          await idbDel('kv', lmKey)
        } else if (!(err.code === 304 || err.status === 304)) {
          throw e
        }
      }
      this.repeatsLoaded = [...new Set([...this.repeatsLoaded, projectId])]
    },
    resetAll() {
      this.tasks = {}
      this.repeats = {}
      this.loadedProjects = []
      this.repeatsLoaded = []
      this.todayOrder = []
    },
  },
})
