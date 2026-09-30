import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { createOssClient, describeOssError } from '@/utils/oss'
import { applyDeletedProjectTombstones, lastModifiedOf, lmKeyOf, versionToken } from '@/utils/sync'
import { enrichOssError } from '@/utils/ossDiag'
import { idbGet, idbPut } from '@/utils/idb'
import type { DeletedProject, Profile, Project } from '@/types'

function isServerEmptyError(e: unknown): boolean {
  const err = e as { code?: string | number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket'
}

let profileLoadPromise: Promise<void> | undefined

/** 精简版 projects store：桌面小组件只读项目列表（不新建/不保存项目）。 */
export const useProjectsStore = defineStore('projects', {
  state: () => ({
    projects: [] as Project[],
    deletedProjects: [] as DeletedProject[],
    loaded: false,
  }),
  getters: {
    byId: (s) => (id: string) => s.projects.find((p) => p.id === id),
  },
  actions: {
    async ensureLoaded() {
      if (!this.loaded) await this.load()
    },
    async load() {
      const auth = useAuthStore()
      if (!auth.username) return
      if (profileLoadPromise) return profileLoadPromise
      profileLoadPromise = this._loadProfile().finally(() => {
        profileLoadPromise = undefined
      })
      return profileLoadPromise
    },
    async _loadProfile() {
      const auth = useAuthStore()
      if (!auth.username) return
      const cached = await idbGet<Profile>('profile', auth.username)
      if (cached) {
        this.projects = applyDeletedProjectTombstones(cached.projects ?? [], cached.deletedProjects ?? [])
        this.deletedProjects = cached.deletedProjects ?? []
      }
      if (!auth.creds) {
        this.loaded = true
        return
      }
      try {
        const client = await createOssClient(auth.creds)
        const etagKey = `etag:${auth.username}:profile`
        const lmKey = lmKeyOf(etagKey)
        const lm = await idbGet<string>('kv', lmKey)
        const res = await client.get(
          `users/${auth.username}/profile.json`,
          lm ? { headers: { 'If-Modified-Since': lm } } : undefined,
        )
        if (res.res.status !== 304) {
          const remote = JSON.parse(res.content.toString()) as Profile
          const cleanRemote: Profile = {
            ...remote,
            projects: applyDeletedProjectTombstones(remote.projects ?? [], remote.deletedProjects ?? []),
          }
          this.projects = cleanRemote.projects
          this.deletedProjects = cleanRemote.deletedProjects ?? []
          await idbPut('profile', auth.username, cleanRemote)
          const newEtag = versionToken(res.res.headers as Record<string, unknown>, res.content) ?? ''
          if (newEtag) await idbPut('kv', etagKey, newEtag)
          const newLm = lastModifiedOf(res.res.headers as Record<string, unknown>)
          if (newLm) await idbPut('kv', lmKey, newLm)
        }
      } catch (e) {
        const err = e as { code?: string | number; status?: number }
        if (!isServerEmptyError(e) && err.status !== 404) {
          throw new Error(await enrichOssError(e, `项目列表加载失败：${describeOssError(e)}`))
        }
      }
      this.loaded = true
    },
    resetAll() {
      this.projects = []
      this.deletedProjects = []
      this.loaded = false
    },
  },
})
