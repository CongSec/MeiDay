import { defineStore } from 'pinia'
import { api } from '@/api/client'
import {
  clearSavedPassword, clearSavedUsername, clearToken, getSavedPassword, getSavedUsername,
  getToken, savePassword, saveUsername, setToken, setUnauthorizedRestoreHook,
} from '@/api/client'
import { idbClearUserCache } from '@/utils/idb'
import { flushPendingSyncReports } from '@/utils/syncReport'
import { decryptCreds, deriveUserKey, passwordVerifier } from '@/utils/crypto'
import type { CredFields } from '@/types'

/** 精简版 auth store：登录 / 自动解锁 / 401 自动恢复 / 登出，供桌面小组件使用。 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    username: '',
    hasCreds: false,
    userKey: null as CryptoKey | null,
    creds: null as CredFields | null,
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
        return true
      } catch {
        return false
      }
    },
    async fetchMe() {
      const me = await api.me()
      this.username = me.username
      this.hasCreds = me.hasCreds
      return me
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
      this.credError = ''
    },
  },
})
