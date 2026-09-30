import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { useStatsStore } from './stats'
import { useUiStore } from './ui'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { applyDeletedTombstones, compareAndSwapPut, lastModifiedOf, lmKeyOf, mergeDeletedTombstones, mergeTasks, versionToken } from '@/utils/sync'
import { idbGet, idbPut, idbDel } from '@/utils/idb'
import { queueSyncChange } from '@/utils/syncReport'
import { nowIso, todayKey } from '@/utils/time'
import { isTaskVisibleToday } from '@/utils/todayFilter'
import { buildRepeatOccurrence, nextRepeatDate, shiftTaskTimes } from '@/utils/repeat'
import { normalizeTasks, taskEffectiveEndTime } from '@/utils/task'
import { addDaysKey, dateKeyOf, diffDaysKey } from '@/utils/time'
import { UNCATEGORIZED, type RepeatMaster, type Task } from '@/types'

/**
 * 桌面小组件的精简版 tasks store。
 *
 * 只覆盖今日视图需要的最小功能集：
 *  - 拉取项目任务 + 今日跨项目顺序表（loadProject / loadTodayOrder）；
 *  - 完成任务 / 取消完成（确认式保存 + 重复模板生成/删除，与主应用逻辑一致）；
 *  - 拖拽排序（setOrder 写回项目 sort + setTodayOrder 写回全局顺序表）；
 *  - 重复任务到期物化（materializeRepeats）。
 *
 * 刻意省略：回收站分片、LRU 逐出、子任务编辑、时间胶囊等今日视图无关逻辑。
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
    all: (s) => Object.values(s.tasks).flat(),
    byProject: (s) => (projectId: string) => s.tasks[projectId] ?? [],
    todayCount: (s) => {
      const today = todayKey()
      return Object.values(s.tasks)
        .flat()
        .filter((t) => t.status === 'pending' && isTaskVisibleToday(t, today)).length
    },
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
          const local = (this.tasks[projectId] ?? []).filter((t) => !t.projectId || t.projectId === projectId)
          const tombstones = mergeDeletedTombstones([], deleted, [])
          const merged = sortActiveList(
            applyDeletedTombstones(mergeTasks(local, activeFiltered), tombstones),
          )
          this.tasks[projectId] = merged
          await idbPut('tasks', taskCacheKey(auth.username, projectId), merged)
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', etagKey, newEtag)
          const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
          if (newLm) await idbPut('kv', lmKey, newLm)
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
    /** 拖拽排序：整体替换该项目任务数组（顺序即展示顺序），写入 sort=下标 */
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
    },
    /** 保存今日视图的跨项目拖拽顺序（独立小文件 + CAS） */
    setTodayOrder(orderedIds: string[]) {
      this.todayOrder = [...orderedIds]
      void idbPut('kv', todayOrderCacheKey(useAuthStore().username), { ids: this.todayOrder })
      void this.saveTodayOrderNow()
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
            await idbDel('kv', lmKeyOf(etagKey))
            await idbPut('kv', todayOrderCacheKey(auth.username), { ids: this.todayOrder })
            queueSyncChange(auth.username, 'today_order', null)
            return true
          }
          if (result.remote && Array.isArray((result.remote as { ids?: string[] }).ids)) {
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
    /** 拉取单个项目：从 OSS 重拉任务并与本地按 updatedAt 合并；远端文件不存在时静默保留本地。 */
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
      if (res.res.status === 304) return
      const remote = JSON.parse(res.content.toString()) as Task[]
      normalizeTasks(remote)
      const { active: rawRemoteActive, deleted: remoteDeleted } = splitDeleted(remote)
      const remoteActive = rawRemoteActive.filter((t) => !t.projectId || t.projectId === projectId)
      const local = (this.tasks[projectId] ?? []).filter((t) => !t.projectId || t.projectId === projectId)
      const tombstones = mergeDeletedTombstones([], remoteDeleted, [])
      const merged = sortActiveList(
        applyDeletedTombstones(mergeTasks(local, remoteActive), tombstones),
      )
      this.tasks[projectId] = merged
      await idbPut('tasks', taskCacheKey(auth.username, projectId), merged)
      const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
      if (newEtag) await idbPut('kv', etagKey, newEtag)
      const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
      if (newLm) await idbPut('kv', lmKey, newLm)
      if (JSON.stringify(merged) !== JSON.stringify(rawRemoteActive)) {
        await this.saveProjectNow(projectId, [...merged])
      }
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
    /** 重复任务到期物化：到期的重复模板生成可见任务；过期多日时只保留“今天”这一次。 */
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
          let guard = 0
          while (dueDate < today && guard < 400) {
            const nd = nextRepeatDate(rule, dueDate)
            if (!nd || nd <= dueDate) break
            dueDate = nd
            guard++
          }
          if (endAfter && dueDate > endAfter) {
            changed = true
            continue
          }
          if (dueDate > today) {
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
          if (isTaskVisibleToday(task, todayKey()) && !this.todayOrder.includes(task.id)) {
            this.todayOrder = [...this.todayOrder, task.id]
            void this.saveTodayOrderNow()
          }
        }
      }
    },
    /** 保存项目任务到 OSS（CAS + 冲突合并） */
    async saveProject(projectId: string, snapshot?: Task[]): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      let list = (snapshot ?? this.tasks[projectId] ?? []).slice()
      const key = paths.tasks(auth.username, projectId)
      const etagKey = `etag:${auth.username}:${projectId}`
      let knownEtag = await idbGet<string>('kv', etagKey)
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await compareAndSwapPut<Task[]>(client, key, list, knownEtag)
          if (result.ok) {
            if (result.etag) await idbPut('kv', etagKey, result.etag)
            await idbDel('kv', lmKeyOf(etagKey))
            await idbPut('tasks', taskCacheKey(auth.username, projectId), list)
            queueSyncChange(auth.username, 'tasks', projectId)
            return true
          }
          if (result.remote) {
            const remoteList = [...(result.remote as Task[])]
            normalizeTasks(remoteList)
            const { active: remoteActive, deleted: remoteDeleted } = splitDeleted(remoteList)
            const filteredRemote = remoteActive.filter((t) => !t.projectId || t.projectId === projectId)
            const tombstones = mergeDeletedTombstones([], remoteDeleted, [])
            list = sortActiveList(applyDeletedTombstones(mergeTasks(list, filteredRemote), tombstones))
            knownEtag = result.remoteEtag ?? undefined
            if (!snapshot) {
              this.tasks[projectId] = list
              await idbPut('tasks', taskCacheKey(auth.username, projectId), list)
            }
          } else {
            knownEtag = undefined
          }
        }
        return false
      } catch (e) {
        console.error('保存任务到 OSS 失败', e)
        return false
      }
    },
    /** 立即保存该项目任务（取消防抖语义已省略，直接保存） */
    async saveProjectNow(projectId: string, snapshot?: Task[]): Promise<boolean> {
      return this.saveProject(projectId, snapshot)
    },
    /** 保存重复模板到 OSS（CAS + 冲突合并） */
    async saveRepeats(projectId: string, snapshot?: RepeatMaster[]): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return false
      const client = await createOssClient(auth.creds)
      let list = (snapshot ?? this.repeats[projectId] ?? []).slice()
      const key = paths.repeats(auth.username, projectId)
      const etagKey = `etag:${auth.username}:${projectId}:repeats`
      let knownEtag = await idbGet<string>('kv', etagKey)
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await compareAndSwapPut<RepeatMaster[]>(client, key, list, knownEtag)
          if (result.ok) {
            if (result.etag) await idbPut('kv', etagKey, result.etag)
            await idbDel('kv', lmKeyOf(etagKey))
            await idbPut('repeats', repeatsCacheKey(auth.username, projectId), list)
            queueSyncChange(auth.username, 'repeats', projectId)
            return true
          }
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
            knownEtag = undefined
          }
        }
        return false
      } catch (e) {
        console.error('保存重复模板到 OSS 失败', e)
        return false
      }
    },
    async saveRepeatsNow(projectId: string): Promise<boolean> {
      return this.saveRepeats(projectId)
    },
    _persist(projectId: string) {
      const auth = useAuthStore()
      void idbPut('tasks', taskCacheKey(auth.username, projectId), this.tasks[projectId] ?? [])
      void this.saveProjectNow(projectId)
    },
    _persistRepeats(projectId: string) {
      const auth = useAuthStore()
      void idbPut('repeats', repeatsCacheKey(auth.username, projectId), this.repeats[projectId] ?? [])
      void this.saveRepeatsNow(projectId)
    },
    _deleteMasterForTask(taskId: string) {
      for (const pid of Object.keys(this.repeats)) {
        const masters = this.repeats[pid] ?? []
        if (!masters.some((m) => m.sourceTaskId === taskId)) continue
        this.repeats[pid] = masters.filter((m) => m.sourceTaskId !== taskId)
        this._persistRepeats(pid)
      }
    },
    /** 完成任务/取消完成的核心翻转（applyStats=false 时跳过统计，供确认式流程在 OSS 成功后补记） */
    _flipComplete(id: string, applyStats: boolean): boolean {
      const task = this.all.find((t) => t.id === id)
      if (!task) return false
      const completing = task.status !== 'completed'
      if (completing && task.repeat) {
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
                rootTaskId: task.repeatRootId ?? task.id,
                dueDate: occ.dueDate,
                template: occ.template,
                createdAt: now,
                updatedAt: now,
              },
            ]
            this._persistRepeats(task.projectId)
          }
        }
      } else if (!completing && task.repeat) {
        this._deleteMasterForTask(task.id)
      }
      task.status = completing ? 'completed' : 'pending'
      const now = nowIso()
      task.updatedAt = now
      for (const s of task.subtasks ?? []) {
        if (s.completed !== completing) {
          s.completed = completing
          s.updatedAt = now
        }
      }
      this._persist(task.projectId)
      if (applyStats) {
        useStatsStore().addDelta(completing ? 1 : -1, task.id)
      }
      return completing
    },
    /** 确认式完成/取消完成：先翻转，立即写盘（重复任务同时写重复模板），OSS 全部成功才返回 true；失败回滚。 */
    async toggleCompleteConfirmed(id: string): Promise<boolean> {
      if (toggleSaving.has(id)) return false
      toggleSaving.add(id)
      try {
        const auth = useAuthStore()
        const task = this.all.find((t) => t.id === id)
        if (!task) return false
        const pid = task.projectId
        if (!this.repeatsLoaded.includes(pid)) await this.loadRepeats(pid).catch(() => {})
        const tasksSnap = (this.tasks[pid] ?? []).slice()
        const repeatsSnap = (this.repeats[pid] ?? []).slice()
        const taskSnap = JSON.parse(JSON.stringify(task))
        const completing = this._flipComplete(id, false)
        const okTasks = await this.saveProjectNow(pid)
        const repeatsChanged = !!task.repeat && JSON.stringify(this.repeats[pid]) !== JSON.stringify(repeatsSnap)
        const okRepeats = repeatsChanged ? await this.saveRepeatsNow(pid) : true
        if (okTasks && okRepeats) {
          await useStatsStore().addDelta(completing ? 1 : -1, task.id)
          return true
        }
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
    /** 立即落盘所有未保存变更（页面隐藏/退出前调用） */
    async flushAll() {
      const jobs: Promise<boolean>[] = []
      for (const [pid, list] of Object.entries(this.tasks)) {
        jobs.push(this.saveProject(pid, [...list]))
      }
      for (const [pid, list] of Object.entries(this.repeats)) {
        jobs.push(this.saveRepeats(pid, [...list]))
      }
      await Promise.allSettled(jobs)
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

const toggleSaving = new Set<string>()
