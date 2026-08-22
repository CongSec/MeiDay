import { defineStore } from 'pinia'
import type OSS from 'ali-oss'
import { useAuthStore } from './auth'
import { useUiStore } from './ui'
import { useStatsStore } from './stats'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { applyDeletedTombstones, compareAndSwapPut, mergeDeletedTombstones, mergeTasks, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbGet, idbPut, idbDel } from '@/utils/idb'
import { debounce, type Debounced } from '@/utils/debounce'
import { dateKeyOf, diffDaysKey, nowIso, todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { buildReminderPayload, buildRepeatOccurrence, nextRepeatDate, rollTask, shiftTaskTimes } from '@/utils/repeat'
import { api } from '@/api/client'
import { logAudit, safeDetail } from '@/utils/audit'
import { UNCATEGORIZED, type RepeatMaster, type Task } from '@/types'
import { newSubtask, normalizeTask, normalizeTasks, pendingSubtaskReminders } from '@/utils/task'
import { deleteAttachments } from '@/utils/attachments'


const saveDebouncers = new Map<string, Debounced<[]>>()
const trashDebouncers = new Map<string, Debounced<[]>>()
let syncReminderTimer: number | undefined

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
function isServerEmptyError(e: unknown): boolean {
  const err = e as { code?: string | number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket'
}

/** 排序活跃任务：pending 在前按截止时间升序，其余置后（补位逻辑，拖拽后不再自动重排） */
function sortActiveList(list: Task[]): Task[] {
  const pending = list
    .filter((t) => t.status === 'pending')
    .sort((a, b) => (a.endTime || '').localeCompare(b.endTime || ''))
  const rest = list
    .filter((t) => t.status !== 'pending')
    .sort((a, b) => (a.endTime || '').localeCompare(b.endTime || ''))
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

/** 拉取远端回收站文件；文件不存在时视为空，网络/权限错误向上抛 */
async function fetchRemoteTrash(client: OSS, username: string, projectId: string): Promise<Task[]> {
  try {
    const res = await client.get(trashFilePath(username, projectId))
    if (res.res.status === 404) return []
    const list = JSON.parse(res.content.toString()) as Task[]
    normalizeTasks(list)
    return list
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') return []
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
  },
  actions: {
    async loadProject(projectId: string) {
      const auth = useAuthStore()
      if (this.loadedProjects.includes(projectId)) return
      const cached = await idbGet<Task[]>('tasks', taskCacheKey(auth.username, projectId))
      if (cached) {
        normalizeTasks(cached)
        const { active, deleted } = splitDeleted(cached)
        this.tasks[projectId] = active
        await idbPut('tasks', taskCacheKey(auth.username, projectId), active)
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
        const client = createOssClient(auth.creds)
        const etag = await idbGet<string>('kv', `etag:${auth.username}:${projectId}`)
        const res = await client.get(
          tasksFilePath(auth.username, projectId),
          etag ? { headers: { 'If-None-Match': etag } } : undefined,
        )
        if (res.res.status !== 304) {
                  const remote = JSON.parse(res.content.toString()) as Task[]
          normalizeTasks(remote)
          const { active, deleted } = splitDeleted(remote)
          this.tasks[projectId] = sortActiveList(active)
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
    /** 仅读 IndexedDB 本地缓存（不访问 OSS），用于侧栏角标等轻量场景 */
    async loadFromIdb(projectIds: string[]) {
      const auth = useAuthStore()
      for (const id of projectIds) {
        if (this.loadedProjects.includes(id)) continue
        const cached = await idbGet<Task[]>('tasks', taskCacheKey(auth.username, id))
        if (cached) {
          normalizeTasks(cached)
          const { active, deleted } = splitDeleted(cached)
          this.tasks[id] = active
          if (deleted.length) {
            this.trash[id] = mergeUnique(this.trash[id] ?? [], deleted)
            await idbPut('trash', trashCacheKey(auth.username, id), this.trash[id])
          }
        }
      }
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
    /** 拉取回收站任务（独立文件，按需加载） */
    async loadTrash(projectId: string) {
      const auth = useAuthStore()
      if (this.trashLoaded.includes(projectId)) return
      const cached = await idbGet<Task[]>('trash', trashCacheKey(auth.username, projectId))
      if (cached) {
        normalizeTasks(cached)
        this.trash[projectId] = cached
      }
      if (!auth.creds) return
      try {
        const client = createOssClient(auth.creds)
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
    async listTrashProjects(): Promise<{ ids: string[]; hasUncategorized: boolean; listed: boolean }> {
      const auth = useAuthStore()
      const ids = new Set<string>()
      let hasUncategorized = false
      let listed = true
      if (auth.creds && auth.username) {
        try {
          const client = createOssClient(auth.creds)
          const res = await client.list(
            { prefix: `users/${auth.username}/`, 'max-keys': 1000 },
            {} as never,
          )
          for (const obj of res.objects ?? []) {
            if (obj.name.endsWith('/trash.json')) {
              const seg = obj.name.split('/')
              ids.add(seg[seg.length - 2])
            } else if (obj.name.endsWith('/today_trash.json')) {
              hasUncategorized = true
            }
          }
        } catch {
          listed = false
          /* 无 list 权限等场景：调用方降级为已知项目 */
        }
      }
      return { ids: [...ids], hasUncategorized, listed }
    },
    /**
     * 手动/下拉刷新同步：强制从 OSS 重新拉取任务并与本地按 updatedAt 合并，
     * 避免多端时间戳冲突（本地相同时间戳优先，防止自己的修改被覆盖）；
     * 有本地改动（含尚未落盘的防抖修改）时把合并结果写回，CAS 兜底冲突。
     * @returns 失败的项目数（0 表示全部成功）
     */
    async syncAll(projectIds: string[]) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return projectIds.length
      const client = createOssClient(auth.creds)
      let failed = 0
      for (const projectId of projectIds) {
        try {
          const key = tasksFilePath(auth.username, projectId)
          const res = await client.get(key)
          const remote = JSON.parse(res.content.toString()) as Task[]
          normalizeTasks(remote)
          const { active: remoteActive, deleted: remoteDeleted } = splitDeleted(remote)
          const local = this.tasks[projectId] ?? []
          const localDeleted = (this.trash[projectId] ?? []).filter((t) => t.status === 'deleted')
          const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
          const tombstones = mergeDeletedTombstones(
            localDeleted,
            remoteDeleted,
            remoteTrash.filter((t) => t.status === 'deleted'),
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
          // 本地相对远端有改动时写回合并结果，让其他设备也能看到（无改动则跳过，省一次写）
          if (JSON.stringify(merged) !== JSON.stringify(remoteActive)) {
            await this.saveProject(projectId, [...merged])
          }
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
    /** 跨天归档：把“非当天完成”的已完成任务移入回收站（次日自动归档，README §6/§8）。
     *  仅 status='completed' 且 updatedAt 日期早于今天才归档；今天完成的保留在活跃列表。
     *  在加载 / 同步 / 跨天检测时调用，不在普通编辑 _persist 里调用，避免 BUG-23 的“悄悄搬家”。 */
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
    async saveProject(projectId: string, snapshot?: Task[]) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = createOssClient(auth.creds)
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
          if (attempt > 0) useUiStore().toast('检测到其他设备同时修改，已自动合并最新数据', 'ok')
          return
        }
        // 冲突：把远端与本地按 updatedAt 合并后再重试，不丢失任一端修改
        if (result.remote) {
          const remoteList = [...(result.remote as Task[])]
          normalizeTasks(remoteList)
          const { active: remoteActive, deleted: remoteDeleted } = splitDeleted(remoteList)
          const localDeleted = (this.trash[projectId] ?? []).filter((t) => t.status === 'deleted')
          const remoteTrash = await fetchRemoteTrash(client, auth.username, projectId)
          const tombstones = mergeDeletedTombstones(
            localDeleted,
            remoteDeleted,
            remoteTrash.filter((t) => t.status === 'deleted'),
          )
          list = sortActiveList(applyDeletedTombstones(mergeTasks(list, remoteActive), tombstones))
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
      } catch (e) {
        console.error('保存任务到 OSS 失败', e)
        useUiStore().toast(`保存失败：${describeOssError(e)}`, 'error')
      }
    },
    async saveTrash(projectId: string, snapshot?: Task[]) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = createOssClient(auth.creds)
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
          if (attempt > 0) useUiStore().toast('检测到其他设备同时修改回收站，已自动合并', 'ok')
          return
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
      } catch (e) {
        console.error('保存回收站到 OSS 失败', e)
        useUiStore().toast(`保存回收站失败：${describeOssError(e)}`, 'error')
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
        void this.saveTrash(projectId)
      } else {
        fn()
      }
    },
    /** 拉取重复模板（独立文件，按需加载，仅主任务完成后生成） */
    async loadRepeats(projectId: string) {
      const auth = useAuthStore()
      if (this.repeatsLoaded.includes(projectId)) return
      const cached = await idbGet<RepeatMaster[]>('repeats', repeatsCacheKey(auth.username, projectId))
      if (cached) this.repeats[projectId] = cached
      if (!auth.creds) return
      try {
        const client = createOssClient(auth.creds)
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
    async saveRepeats(projectId: string, snapshot?: RepeatMaster[]) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = createOssClient(auth.creds)
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
            return
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
      } catch (e) {
        console.error('保存重复任务到 OSS 失败', e)
        useUiStore().toast(`保存重复任务失败：${describeOssError(e)}`, 'error')
      }
    },
    /** 重复模板变更持久化（立即保存，完成/删除模板属低频操作） */
    _persistRepeats(projectId: string) {
      const auth = useAuthStore()
      void idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId] ?? [])
      void this.saveRepeats(projectId)
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
      if (idx >= 0) Object.assign(list[idx], task)
      else list.push(task)
      // README：恢复/增删时按截止时间补位；仅新插入/移动项目时重排，避免覆盖拖拽手动顺序
      this.tasks[target] = isNew ? sortActiveList(list) : list
      this._persist(target)
      // 编辑源任务后同步重复模板：保持后续周期属性一致；移除重复则删除模板（周期提醒随之停止）
      this._syncRepeatMasterForTask(task)
      logAudit(isNew ? '新增任务' : '修改任务', safeDetail(`任务ID：${task.id}，项目ID：${target}`))
    },
    /** 拖拽排序：整体替换该项目的任务数组（顺序即展示顺序） */
    setOrder(projectId: string, ordered: Task[]) {
      this.tasks[projectId] = ordered
      this._persist(projectId)
      logAudit('调整任务顺序', safeDetail(`项目ID：${projectId}，共 ${ordered.filter((t) => t.status === 'pending').length} 项`))
    },
    toggleComplete(id: string) {
      const task = this.all.find((t) => t.id === id)
      if (!task) return
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
      // 累计完成任务统计（存用户 OSS，绝不清零/重算）：完成 +1，取消完成 -1
      useStatsStore().addDelta(completing ? 1 : -1, task.id)
      logAudit(completing ? '完成任务' : '取消完成', safeDetail(`任务ID：${task.id}，项目ID：${task.projectId}`))
    },
    softDelete(id: string) {
      const task = this.all.find((t) => t.id === id)
      if (!task) return
      task.status = 'deleted'
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
      task.status = 'pending'
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
      const moved = active.map((t) => ({ ...t, status: 'deleted' as const, updatedAt: nowIso() }))
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
        const restored = deleted.map((t) => ({ ...t, status: 'pending' as const, updatedAt: nowIso() }))
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
        status: 'pending' as const,
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
    /** 立即落盘所有未保存变更（页面隐藏/关闭、登出前调用）。
     *  这里在清空 store 之前先拷贝快照，避免登出竞态把空数组写到 OSS。 */
    async flushAll() {
      const jobs: Promise<void>[] = []
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
    },
  },
})



