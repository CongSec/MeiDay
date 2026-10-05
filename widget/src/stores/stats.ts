import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { createOssClient, paths } from '@/utils/oss'
import { lastModifiedOf, lmKeyOf, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbGet, idbPut } from '@/utils/idb'
import type { UserStats } from '@/types'
/**
 * 用户统计 store（全部存于用户 OSS 的 stats.json，不上服务器）。
 *
 * 桌面小组件只读展示统计：仅 load() 从 OSS 拉取 / completedCount 只读，
 * 不含任何写路径（不写 OSS、不上报同步变更）。统计的写入全部由 App/网页端负责。
 */
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
      const cached = await idbGet<UserStats>('kv', cacheKey(auth.username))
      if (cached) this.stats = cached
      if (!auth.creds) {
        this.loaded = true
        return
      }
      try {
        const client = await createOssClient(auth.creds)
        // 读路径条件请求用 If-Modified-Since（Last-Modified）：阿里云 OSS 不带 ETag 头，
        // 只认 Last-Modified 回 304；etag 键仅用于本地缓存比对。
        const eKey = etagKey(auth.username)
        const lmKey = lmKeyOf(eKey)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          paths.stats(auth.username),
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as UserStats
          this.stats = remote
          await idbPut('kv', cacheKey(auth.username), remote)
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', eKey, newEtag)
          const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
          if (newLm) await idbPut('kv', lmKey, newLm)
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
    /** 清空内存态（登出/切换账号/会话失效时调用） */
    resetAll() {
      this.stats = null
      this.loaded = false
    },
  },
})

