import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { createOssClient, describeOssError, paths } from '@/utils/oss'
import { compareAndSwapPut, mergeStats, mergeStatsAfterSave, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbGet, idbPut } from '@/utils/idb'
import { nowIso, todayKey } from '@/utils/time'
import type { UserStats } from '@/types'

/**
 * 用户统计 store（全部存于用户 OSS 的 stats.json，不上服务器）。
 *
 * 关键约束（用户明确要求）：
 * 1. firstProjectAt 在“首次创建项目”时写入一次，之后绝不修改、绝不清零；
 * 2. 累计完成任务数只做增量维护（完成 +1 / 取消完成 -1），
 *    严禁任何“从任务列表重新计算 / 清零”的逻辑；
 * 3. 即使服务器变更，stats.json 中的时间与计数也不可重算。
 *
 * 计数采用“按天净增量”结构：daily[日期] = { v, ts, tasks }，当前累计 = 所有 v 之和。
 * tasks 记录当天每个任务的最近完成/取消状态，供多端冲突合并时逐任务去重；
 * firstProjectAt 取最早非空，天然安全且不丢历史。
 */

let statsSaveTimer: number | undefined

function emptyStats(): UserStats {
  return { daily: {}, updated_at: nowIso() }
}

function isServerEmptyError(e: unknown): boolean {
  const err = e as { code?: string | number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket'
}

function cacheKey(username: string): string {
  return `stats:${username}`
}

function etagKey(username: string): string {
  return `etag:${username}:stats`
}

export const useStatsStore = defineStore('stats', {
  state: () => ({
    stats: null as UserStats | null,
    loaded: false,
  }),
  getters: {
    firstProjectAt: (s) => s.stats?.firstProjectAt ?? '',
    /** 累计完成任务数量 = 所有按天净增量之和（只读展示，绝不由此回写） */
    completedCount: (s) => {
      let total = 0
      for (const k in s.stats?.daily ?? {}) total += s.stats!.daily[k].v
      return total
    },
  },
  actions: {
    async ensureLoaded() {
      if (!this.loaded) await this.load()
    },
    /** 从本地缓存 + OSS 加载统计（OSS 为权威；首次使用无文件属正常） */
    async load() {
      const auth = useAuthStore()
      if (!auth.username) return
      // 本地还有未落盘的统计变更（防抖 500ms 内）：不覆盖内存，等写盘时用 CAS+merge 与远端合并，
      // 避免“先改后查”把内存中刚写入的 firstProjectAt/当日增量被旧远端值覆盖掉（时间/计数不可变约束）。
      const hasPending = statsSaveTimer !== undefined
      const cached = await idbGet<UserStats>('kv', cacheKey(auth.username))
      if (cached && !hasPending) this.stats = cached
      if (!auth.creds) {
        this.loaded = true
        return
      }
      if (hasPending) {
        this.loaded = true
        return
      }
      try {
        const client = createOssClient(auth.creds)
        const etag = await idbGet<string>('kv', etagKey(auth.username))
        const res = await client.get(
          paths.stats(auth.username),
          etag ? { headers: { 'If-None-Match': etag } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as UserStats
          this.stats = remote
          await idbPut('kv', cacheKey(auth.username), remote)
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', etagKey(auth.username), newEtag)
        }
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        const is304 = err.code === 304 || err.status === 304
        if (!is304 && !isServerEmptyError(e)) {
          // stats 文件首次使用尚不存在（NoSuchKey）属正常，不视为错误
          throw new Error(await enrichOssError(e))
        }
      }
      this.loaded = true
    },
    _persist() {
      const auth = useAuthStore()
      if (!this.stats) this.stats = emptyStats()
      this.stats.updated_at = nowIso()
      if (auth.username) {
        void idbPut('kv', cacheKey(auth.username), JSON.parse(JSON.stringify(this.stats)))
      }
      // 固定快照，避免防抖写盘期间后续变更被覆盖
      const snapshot = JSON.parse(JSON.stringify(this.stats)) as UserStats
      if (statsSaveTimer) window.clearTimeout(statsSaveTimer)
      statsSaveTimer = window.setTimeout(() => {
        statsSaveTimer = undefined
        void this.save(snapshot)
      }, 500)
    },
    /** CAS 写入 + 冲突合并（最多重试 3 次），不丢任何一端的增量 */
    async save(snapshot?: UserStats) {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      const client = createOssClient(auth.creds)
      let stats = (snapshot ?? this.stats ?? emptyStats())
      const key = paths.stats(auth.username)
      const eKey = etagKey(auth.username)
      let knownEtag = await idbGet<string>('kv', eKey)
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await compareAndSwapPut<UserStats>(client, key, stats, knownEtag)
          if (result.ok) {
            if (result.etag) await idbPut('kv', eKey, result.etag)
            await idbPut('kv', cacheKey(auth.username), stats)
            if (snapshot && this.stats) {
              // 快照保存成功不代表内存没有变化：远端合并结果只回填到未再改动的当天，
              // 快照之后新产生的本地改动继续保留，交给下一次 save 的 CAS 合并
              this.stats = mergeStatsAfterSave(this.stats, stats, snapshot)
            } else if (!snapshot) {
              this.stats = stats
            }
            return
          }
          if (result.remote) {
            stats = mergeStats(stats, result.remote as UserStats)
            knownEtag = result.remoteEtag ?? undefined
            if (!snapshot) {
              this.stats = stats
              await idbPut('kv', cacheKey(auth.username), stats)
            }
          } else {
            knownEtag = undefined
          }
        }
        console.warn('保存统计到 OSS 失败：检测到其他设备持续修改')
      } catch (e) {
        console.error('保存统计到 OSS 失败', e)
      }
    },
    /** 首次创建项目时记录起始时间；一旦写入，永不修改、绝不回填重算。
     *  先加载 OSS 中的 stats，仅在确认不存在 firstProjectAt 时才写入，
     *  避免刷新/换设备后把已记录的首次时间覆盖掉。 */
    async ensureFirstProjectAt() {
      const auth = useAuthStore()
      if (!auth.creds || !auth.username) return
      // 内存中已记录（例如刚由 addProject 写入）则直接返回，不再查 OSS
      if (this.stats?.firstProjectAt) return
      await this.load()
      if (this.stats?.firstProjectAt) return
      if (!this.stats) this.stats = emptyStats()
      this.stats.firstProjectAt = nowIso()
      this._persist()
    },
    /** 记录一次完成(+1) 或取消完成(-1)：按当天净增量累计，绝不清零重算。
     *  taskId 用于记录该任务当天最近状态，合并时避免已同步的计数再次相加。
     *  首次调用前先加载 OSS，避免用空统计覆盖已有历史（时间/计数不可变约束）。 */
    async addDelta(delta: number, taskId?: string) {
      if (!delta) return
      if (!this.loaded) await this.load()
      const key = todayKey()
      if (!this.stats) this.stats = emptyStats()
      if (!this.stats.daily) this.stats.daily = {}
      const ts = nowIso()
      const cur = this.stats.daily[key]?.v ?? 0
      const entry = this.stats.daily[key] ?? { v: 0, ts }
      if (taskId) {
        entry.tasks = entry.tasks ?? {}
        entry.tasks[taskId] = { v: delta > 0 ? 1 : 0, ts }
      }
      this.stats.daily[key] = { ...entry, v: cur + delta, ts }
      this._persist()
    },
    /** 立即落盘未保存的统计变更（页面隐藏/登出前调用） */
    async flush() {
      if (statsSaveTimer !== undefined && this.stats) {
        const snapshot = JSON.parse(JSON.stringify(this.stats)) as UserStats
        window.clearTimeout(statsSaveTimer)
        statsSaveTimer = undefined
        await this.save(snapshot)
      }
    },
    /** 清空内存态并取消未保存的统计写盘（登出/切换账号/会话失效时调用） */
    resetAll() {
      if (statsSaveTimer !== undefined) {
        window.clearTimeout(statsSaveTimer)
        statsSaveTimer = undefined
      }
      this.stats = null
      this.loaded = false
    },
  },
})

// 页面隐藏/关闭前尽量落盘，减少“防抖 500ms 内关闭导致 OSS 未保存”
if (typeof window !== 'undefined') {
  const onHide = () => {
    void useStatsStore().flush()
  }
  window.addEventListener('pagehide', onHide)
  window.addEventListener('beforeunload', onHide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void useStatsStore().flush()
  })
}
