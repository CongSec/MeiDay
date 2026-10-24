import { defineStore } from 'pinia'
import { api } from '@/api/client'
import {
  clearSavedPassword, clearSavedUsername, clearToken, getSavedPassword, getSavedUsername,
  getToken, savePassword, saveUsername, setToken, setUnauthorizedRestoreHook,
} from '@/api/client'
import { idbClearUserCache, idbGet, idbPut } from '@/utils/idb'
import { flushPendingSyncReports } from '@/utils/syncReport'
import { decryptCreds, deriveUserKey, passwordVerifier } from '@/utils/crypto'
import type { CredFields } from '@/types'

/** ---- 本地凭证密文缓存（离线解锁的前提,与网页端同款实现） ----
 *  服务器不可达时,用「记住的密码 + 用户名」离线派生 userKey,解密本地缓存的
 *  凭证密文,即可继续读写用户自己的 OSS 数据。密文与服务器存的是同一份,
 *  不新增明文暴露面;登出/401 由 idbClearUserCache 清除。 */
const CREDS_CACHE_PREFIX = 'creds:'
interface CredsCacheEntry {
  encrypted: string | null
  updatedAt: string | null
}

async function saveCredsCache(username: string, encrypted: string | null, updatedAt: string | null): Promise<void> {
  if (!username) return
  await idbPut('kv', `${CREDS_CACHE_PREFIX}${username}`, { encrypted, updatedAt })
}

async function loadCredsCache(username: string): Promise<CredsCacheEntry | null> {
  if (!username) return null
  return (await idbGet<CredsCacheEntry>('kv', `${CREDS_CACHE_PREFIX}${username}`)) ?? null
}

/** 精简版 auth store：登录 / 自动解锁 / 401 自动恢复 / 登出 / 离线解锁，供桌面小组件使用。 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    username: '',
    hasCreds: false,
    userKey: null as CryptoKey | null,
    creds: null as CredFields | null,
    /** 服务器记录的 OSS 凭证最近更新时刻（/api/me 下发，本地缓存新鲜度校验用） */
    credsUpdatedAt: null as string | null,
    credError: '',
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
  },
  actions: {
    async login(username: string, password: string, remember = true) {
      const verifier = await passwordVerifier(password)
      const r = await api.login({ username, passwordHash: verifier })
      this.token = r.sessionToken
      setToken(r.sessionToken)
      this.userKey = await deriveUserKey(password, username)
      this.credError = ''
      if (r.encrypted_creds) {
        try {
          this.creds = await decryptCreds(this.userKey, r.encrypted_creds)
        } catch {
          this.creds = null
          this.credError = '无法解密已保存的 OSS 凭证，请在网页端「设置」中重新配置 OSS'
        }
      } else {
        this.creds = null
      }
      await this.fetchMe()
      // 缓存服务器下发的凭证密文 + 更新时间，供服务器不可达时离线解锁
      await saveCredsCache(this.username, r.encrypted_creds, this.credsUpdatedAt)
      saveUsername(this.username)
      if (remember) savePassword(password)
      else clearSavedPassword()
    },
    /** 刷新/重启后自动解锁：用浏览器保存的密码（7 天内）重新派生 userKey */
    async tryAutoUnlock(): Promise<boolean> {
      if (this.userKey && this.username) return true
      if (!this.username) this.username = getSavedUsername()
      if (!this.username) return false
      const pw = getSavedPassword()
      if (!pw) return false
      try {
        const verifier = await passwordVerifier(pw)
        const r = await api.login({ username: this.username, passwordHash: verifier }, this.token || undefined)
        this.token = r.sessionToken
        setToken(r.sessionToken)
        this.userKey = await deriveUserKey(pw, this.username)
        this.creds = r.encrypted_creds ? await decryptCreds(this.userKey, r.encrypted_creds) : null
        saveUsername(this.username)
        savePassword(pw)
        // 刷新本地凭证密文缓存（同步最新密文 + 已知的更新时间）
        await saveCredsCache(this.username, r.encrypted_creds, this.credsUpdatedAt)
        return true
      } catch {
        return false
      }
    },
    async fetchMe() {
      const me = await api.me()
      this.username = me.username
      this.hasCreds = me.hasCreds
      this.credsUpdatedAt = me.creds_updated_at ?? null
      return me
    },
    /** 离线解锁：服务器不可达时，用「记住的密码（或手动输入的密码）」+ 本地缓存的
     *  凭证密文离线派生 userKey 并解密出 OSS 凭证。成功返回 true，失败返回 false。 */
    async tryOfflineUnlock(password?: string): Promise<boolean> {
      if (this.userKey && this.creds) return true
      const username = this.username || getSavedUsername()
      if (!username) return false
      const pw = password || getSavedPassword()
      if (!pw) return false
      const cached = await loadCredsCache(username)
      if (!cached || !cached.encrypted) return false
      try {
        const key = await deriveUserKey(pw, username)
        const fields = await decryptCreds(key, cached.encrypted)
        this.userKey = key
        this.creds = fields
        this.hasCreds = true
        this.username = username
        this.credsUpdatedAt = cached.updatedAt ?? null
        return true
      } catch {
        return false
      }
    },
    restoreUser() {
      if (!this.username) this.username = getSavedUsername()
    },
    registerRestoreHook() {
      setUnauthorizedRestoreHook(async () => {
        if (!getToken()) return false
        if (!this.username) this.username = getSavedUsername()
        return this.tryAutoUnlock()
      })
    },
    async logout() {
      const username = this.username
      try {
        await api.logout()
      } catch {
        /* ignore */
      }
      await flushPendingSyncReports(username)
      this.reset()
      if (username) await idbClearUserCache(username)
    },
    reset() {
      clearToken()
      clearSavedPassword()
      clearSavedUsername()
      this.token = ''
      this.username = ''
      this.hasCreds = false
      this.userKey = null
      this.creds = null
      this.credsUpdatedAt = null
      this.credError = ''
    },
  },
})
