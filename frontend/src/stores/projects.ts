import { defineStore } from 'pinia'
import { api } from '@/api/client'
import { useAuthStore } from './auth'
import { useUiStore } from './ui'
import { useTasksStore } from './tasks'
import { useStatsStore } from './stats'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { applyDeletedProjectTombstones, compareAndSwapPut, mergeProfile, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbGet, idbPut, idbDel } from '@/utils/idb'
import { nowIso } from '@/utils/time'
import { logAudit, safeDetail } from '@/utils/audit'
import type { DeletedProject, Profile, Project } from '@/types'

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

/** 服务端明确“该文件/存储不存在”的错误码：表示云端没有权威数据，本地缓存应作废 */
function isServerEmptyError(e: unknown): boolean {
  const err = e as { code?: string | number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket'
}

let profileSaveTimer: number | undefined

export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [] as Project[],
    deletedProjects: [] as DeletedProject[],
    loaded: false,
  }),
  getters: {
    byId: (s) => (id: string) => s.projects.find((p) => p.id === id),
    countBy: () => (projectId: string) => {
      const tasks = useTasksStore()
      return tasks.tasks[projectId]?.filter((t) => t.status === 'pending').length ?? 0
    },
  },
  actions: {
    async ensureLoaded() {
      if (!this.loaded) await this.load()
    },
    async load() {
      const auth = useAuthStore()
      if (!auth.username) return
      const cached = await idbGet<Profile>('profile', auth.username)
      // R2-BUG-3: 本地已有待写盘的 profile 变更（如刚删除项目、防抖 save 尚未执行）时，
      // 不要用可能过期的 idb/OSS 缓存覆盖内存，避免删除后项目在本地/后续保存中“复活”。
      const hasPendingProfileSave = profileSaveTimer !== undefined
      if (cached && !hasPendingProfileSave) {
        this.projects = applyDeletedProjectTombstones(cached.projects ?? [], cached.deletedProjects ?? [])
        this.deletedProjects = cached.deletedProjects ?? []
      }
      if (auth.creds && !hasPendingProfileSave) {
        try {
          const client = createOssClient(auth.creds)
          const etag = await idbGet<string>('kv', `etag:${auth.username}:profile`)
          const res = await client.get(
            paths.profile(auth.username),
            etag ? { headers: { 'If-None-Match': etag } } : undefined,
          )
          if (res.res.status !== 304) {
            const remote = JSON.parse(res.content.toString()) as Profile
            if (!cached || remote.updated_at !== cached.updated_at) {
              const cleanRemote: Profile = {
                ...remote,
                projects: applyDeletedProjectTombstones(remote.projects ?? [], remote.deletedProjects ?? []),
              }
              this.projects = cleanRemote.projects
              this.deletedProjects = cleanRemote.deletedProjects ?? []
              await idbPut('profile', auth.username, cleanRemote)
            }
            const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
            if (newEtag) await idbPut('kv', `etag:${auth.username}:profile`, newEtag)
          }
        } catch (e) {
          const err = e as { code?: string | number; status?: number }
          const is304 = err.code === 304 || err.status === 304
          if (is304) {
            // 缓存与云端一致，无需处理
          } else if (isServerEmptyError(e)) {
            // 服务端 profile 已不存在（bucket/文件被删除）：本地缓存作废，
            // 避免旧项目列表被当作权威展示或在下次编辑时同步回云端
            this.projects = []
            this.deletedProjects = []
            await idbDel('profile', auth.username)
            await idbDel('kv', `etag:${auth.username}:profile`)
          } else {
            throw new Error(await enrichOssError(e))
          }
        }
      }
      // 已有项目的存量用户首次加载：一次性记录“首次创建项目时间”（此后永不修改）。
      // 纯新用户（无项目）不记录，等真正创建第一个项目时再由 addProject 记录。
      if (this.projects.length > 0) useStatsStore().ensureFirstProjectAt()
      this.loaded = true
    },
    _persist() {
      const auth = useAuthStore()
      // R2-BUG-3: 在调度防抖写盘时就固定快照，避免导航触发的 load() 把旧 profile
      // 覆盖回内存后，防抖保存读到“复活”的项目列表再写回 OSS，导致删除永不生效。
      const snapshot: Profile = {
        projects: applyDeletedProjectTombstones([...this.projects], this.deletedProjects ?? []),
        deletedProjects: [...(this.deletedProjects ?? [])],
        updated_at: nowIso(),
      }
      if (auth.username) {
        void idbPut('profile', auth.username, snapshot)
      }
      if (profileSaveTimer) window.clearTimeout(profileSaveTimer)
      profileSaveTimer = window.setTimeout(() => {
        profileSaveTimer = undefined
        void this.save(snapshot)
      }, 500)
    },
    async save(snapshot?: Profile) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = createOssClient(auth.creds)
      // 使用快照，避免登出/重置竞态下读到被清空的 store
      let profile: Profile = snapshot ?? {
        projects: applyDeletedProjectTombstones([...this.projects], this.deletedProjects ?? []),
        deletedProjects: [...(this.deletedProjects ?? [])],
        updated_at: nowIso(),
      }
      const key = paths.profile(auth.username)
      const etagKey = `etag:${auth.username}:profile`
      let knownEtag = await idbGet<string>('kv', etagKey)

      try {
      // CAS 写入 + 冲突合并：最多重试 3 次，防止多端同时改项目列表互相覆盖
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await compareAndSwapPut<Profile>(client, key, profile, knownEtag)
        if (result.ok) {
          if (result.etag) await idbPut('kv', etagKey, result.etag)
          await idbPut('profile', auth.username, profile)
          if (attempt > 0) useUiStore().toast('检测到其他设备同时修改，已合并项目列表', 'ok')
          return
        }
        if (result.remote) {
          profile = mergeProfile(profile, result.remote as Profile)
          knownEtag = result.remoteEtag ?? undefined
          if (!snapshot) {
            this.projects = profile.projects
            this.deletedProjects = profile.deletedProjects ?? []
            await idbPut('profile', auth.username, profile)
          }
        } else {
          knownEtag = undefined
        }
      }
      useUiStore().toast('保存项目列表失败：检测到其他设备持续修改，请稍后重试', 'error')
      } catch (e) {
        console.error('保存项目列表到 OSS 失败', e)
        useUiStore().toast(`保存项目列表失败：${describeOssError(e)}`, 'error')
      }
    },
    /** 立即落盘 profile（如果有未保存的项目变更），用于页面隐藏/登出前调用 */
    async flushProfile() {
      if (profileSaveTimer !== undefined) {
        const snapshot: Profile = {
          projects: applyDeletedProjectTombstones([...this.projects], this.deletedProjects ?? []),
          deletedProjects: [...(this.deletedProjects ?? [])],
          updated_at: nowIso(),
        }
        window.clearTimeout(profileSaveTimer)
        profileSaveTimer = undefined
        await this.save(snapshot)
      }
    },
    /** 清空本仓库内存态并取消未保存的 profile 定时任务 */
    resetAll() {
      if (profileSaveTimer !== undefined) {
        window.clearTimeout(profileSaveTimer)
        profileSaveTimer = undefined
      }
      this.projects = []
      this.deletedProjects = []
      this.loaded = false
    },
    addProject(name: string): Project {
      const p: Project = {
        id: crypto.randomUUID(),
        name,
        color: COLORS[this.projects.length % COLORS.length],
        icon: '📁',
      }
      this.projects.push(p)
      // 首次创建项目时记录起始时间；一旦写入，之后绝不修改（stats store 内守卫）
      useStatsStore().ensureFirstProjectAt()
      void this._persist()
      logAudit('新建项目', safeDetail(`项目ID：${p.id}`))
      return p
    },
    renameProject(id: string, name: string) {
      const p = this.byId(id)
      if (!p) return
      p.name = name
      void this._persist()
      // 项目名称属于敏感数据，日志只记录项目 ID，不记录新旧名称
      logAudit('重命名项目', safeDetail(`项目ID：${id}`))
    },
    setOrder(ordered: Project[]) {
      this.projects = ordered
      void this._persist()
      logAudit('调整项目顺序', safeDetail(`共 ${ordered.length} 个项目`))
    },
    /**
     * 删除项目 = 移入回收站：项目从活跃列表移除（元数据保留到 deletedProjects 以便整项目恢复），
     * 其下全部任务移入回收站文件。不删除回收站 OSS 文件（可恢复整个项目）。
     */
    async deleteProject(id: string) {
      const p = this.byId(id)
      if (!p) return
      this.projects = this.projects.filter((x) => x.id !== id)
      // 保留项目元数据（id/名称/颜色/图标 + 删除时间），供回收站「恢复整个项目」使用
      this.deletedProjects = [
        ...(this.deletedProjects ?? []).filter((x) => x.id !== id),
        { id: p.id, name: p.name, color: p.color, icon: p.icon, deletedAt: nowIso() },
      ]
      const tasks = useTasksStore()
      tasks.markAllDeleted(id)
      void this._persist()
      logAudit('删除项目', safeDetail(`项目ID：${id}，其下任务已移入回收站`))
      const auth = useAuthStore()
      // 显式清空该项目在服务端的提醒行，避免残留提醒继续发信（BUG-12）
      if (auth.token && id) {
        try {
          await api.syncReminders([], [id])
        } catch {
          /* 网络失败不阻塞删除 */
        }
      }
      // 注意：不删除 projects/{id}/trash.json，回收站文件保留以便「恢复整个项目」。
    },
    /** 恢复已删除项目：无重名时整项目恢复（任务从回收站还原为活跃）；重名时合并进同名现有项目 */
    async restoreProject(id: string): Promise<string | undefined> {
      const dp = (this.deletedProjects ?? []).find((x) => x.id === id)
      if (!dp) return undefined
      const tasks = useTasksStore()
      const existing = this.projects.find((x) => x.name === dp.name)
      const auth = useAuthStore()
      // 恢复前先把该项目的回收站文件从 OSS/本地缓存加载到内存，避免刷新后整项目恢复丢任务
      try {
        await tasks.loadTrash(id)
      } catch {
        /* 网络失败时降级为本地缓存，不阻塞恢复 */
      }
      if (existing) {
        // 重名：不新建项目，把该项目的任务（含回收站）合并进同名现有项目，避免出现重名项目
        tasks.mergeProjectInto(id, existing.id)
        this.deletedProjects = (this.deletedProjects ?? []).filter((x) => x.id !== id)
        void this._persist()
        logAudit('恢复项目（重名合并）', safeDetail(`项目ID：${id}，已合并入 ${existing.id}`))
        if (auth.token) {
          try {
            await tasks.syncReminders()
          } catch {
            /* 网络失败不阻塞恢复 */
          }
        }
        return existing.id
      }
      // 正常恢复：原 id 原样放回活跃列表，任务从回收站还原为活跃
      this.projects.push({ id: dp.id, name: dp.name, color: dp.color, icon: dp.icon })
      this.deletedProjects = (this.deletedProjects ?? []).filter((x) => x.id !== id)
      tasks.restoreProjectTasks(id)
      void this._persist()
      logAudit('恢复项目', safeDetail(`项目ID：${id}`))
      if (auth.token) {
        try {
          await tasks.syncReminders()
        } catch {
          /* 网络失败不阻塞恢复 */
        }
      }
      return dp.id
    },
  },
})

// 页面隐藏/关闭前尽量落盘 profile，减少“关闭过早导致项目顺序/新增项目未保存”
if (typeof window !== 'undefined') {
  const onHide = () => useProjectsStore().flushProfile()
  window.addEventListener('pagehide', onHide)
  window.addEventListener('beforeunload', onHide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') useProjectsStore().flushProfile()
  })
}
