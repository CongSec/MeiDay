import { defineStore } from 'pinia'
import { api } from '@/api/client'
import { ApiError, clearSavedPassword, clearSavedUsername, clearToken, getSavedPassword, getSavedUsername, getToken, savePassword, saveUsername, setToken, setUnauthorizedRestoreHook } from '@/api/client'
import type { LoginResponse, SmtpPlain } from '@/api/client'
import { idbClearUserCache } from '@/utils/idb'
import { flushPendingSyncReports } from '@/utils/syncReport'
import { useUiStore } from './ui'
import { decryptCreds, deriveUserKey, encryptCreds, passwordVerifier } from '@/utils/crypto'
import type { CredFields } from '@/types'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getToken(),
    username: '',
    hasCreds: false,
    userKey: null as CryptoKey | null,
    creds: null as CredFields | null,
    /** 登录时 OSS 凭证解密失败的提示（不阻断登录，仅提示重新配置） */
    credError: '',
  }),
  getters: {
    isLoggedIn: (s) => !!s.token,
  },
  actions: {
    /** 登录只发送 SHA-256(password) 校验子（不可逆密文）。旧账号（428）自动走一次性明文迁移。 */
    async login(username: string, password: string, remember = true) {
      const verifier = await passwordVerifier(password)
      let r: LoginResponse
      try {
        r = await api.login({ username, passwordHash: verifier })
      } catch (e) {
        // 历史账号（auth_version=0）无法用校验子登录，需发送一次明文密码升级校验方案
        if (e instanceof ApiError && e.status === 428) {
          r = await api.legacyLogin({ username, password })
        } else {
          throw e
        }
      }
      this.token = r.sessionToken
      setToken(r.sessionToken)
      this.userKey = await deriveUserKey(password, username)
      // 尝试解密 OSS 凭证：失败（旧密码/凭证损坏等）不再中断登录，否则会把用户
      // 锁在登录页却只显示莫名的“操作失败”。失败时置空 creds 并提示重新配置。
      this.credError = ''
      if (r.encrypted_creds) {
        try {
          this.creds = await decryptCreds(this.userKey, r.encrypted_creds)
        } catch (e) {
          this.creds = null
          this.credError = '无法解密已保存的 OSS 凭证（可能由旧密码或损坏数据产生），请在「设置」中重新配置 OSS 后即可正常使用'
        }
      } else {
        this.creds = null
      }
      await this.fetchMe()
      saveUsername(this.username)
      if (remember) savePassword(password)
      else clearSavedPassword()
      if (this.credError) useUiStore().toast(this.credError, 'error')
    },
    async register(body: { username: string; password: string; encrypted_creds?: string | null; smtp_plain?: SmtpPlain | null; captchaId: string; captchaAnswer: number[] }, remember = true) {
      const passwordHash = await passwordVerifier(body.password)
      await api.register({
        username: body.username,
        passwordHash,
        encrypted_creds: body.encrypted_creds,
        smtp_plain: body.smtp_plain,
        captchaId: body.captchaId,
        captchaAnswer: body.captchaAnswer,
      })
      await this.login(body.username, body.password, remember)
    },
    /** 刷新后自动解锁：用浏览器保存的密码（7 天内）重新派生 userKey。
     *  网络/后端临时不可达导致失败时不销毁保存的密码（避免反复要求重新输入）；
     *  仅当密码本身错误（登录返回 401，会触发 st:unauthorized 重置）时才清除。 */
    async tryAutoUnlock(): Promise<boolean> {
      // 已在内存解锁（比如 401 自动恢复刚用记住的密码重登过），直接视为解锁成功，
      // 避免每次刷新/重启都重复重登挤占服务端会话
      if (this.userKey && this.username) return true
      if (!this.username) this.username = getSavedUsername()
      if (!this.username) return false
      const pw = getSavedPassword()
      if (!pw) return false
      try {
        const verifier = await passwordVerifier(pw)
        let r: LoginResponse
        try {
          // 携带当前有效 token 重登（自动解锁场景）：后端据此判定为同一会话的
          // 静默恢复，不再触发 login_success 邮件，避免每次刷新都轰炸邮箱。
          r = await api.login({ username: this.username, passwordHash: verifier }, this.token || undefined)
        } catch (e) {
          if (e instanceof ApiError && e.status === 428) {
            r = await api.legacyLogin({ username: this.username, password: pw }, this.token || undefined)
          } else {
            throw e
          }
        }
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
    async saveCredentials(fields: CredFields) {
      if (!this.userKey) throw new Error('会话密钥缺失，请重新登录')
      const encrypted = await encryptCreds(this.userKey, fields)
      await api.updateCredentials({
        encrypted_creds: encrypted,
        smtp_plain: {
          smtp_user: fields.smtpUser,
          smtp_pass: fields.smtpPass,
          notify_email: fields.notifyEmail,
        },
      })
      this.creds = fields
      this.hasCreds = true
      // 凭证变化后必须重新从 OSS 加载（尤其是新注册后首次配置），并清空旧内存态。
      // 先落盘未保存变更，再清空内存从 OSS 重新加载，避免改完凭证即丢未保存任务（BUG-21）
      const { useProjectsStore } = await import('./projects')
      const { useTasksStore } = await import('./tasks')
      await Promise.allSettled([useTasksStore().flushAll(), useProjectsStore().flushProfile()])
      useProjectsStore().resetAll()
      useTasksStore().resetAll()
    },
/** 修改密码（旧密码校验通过后）：
     *  1. 只发送 SHA-256 校验子（不发送明文密码）；
     *  2. 用新密码派生密钥重新加密 OSS 凭证，保证后续解密 / 离线提醒仍可用；
     *  3. 更新内存中的 userKey 与浏览器保存的密码（自动解锁不失效）。 */
    async changePassword(oldPassword: string, newPassword: string) {
      const oldVerifier = await passwordVerifier(oldPassword)
      const newVerifier = await passwordVerifier(newPassword)
      const oldKey = this.userKey
      const newKey = await deriveUserKey(newPassword, this.username)
      // 防守性检查：若服务端已保存凭证、但当前内存中无法解密（creds 为 null，可能是旧密码/滞留会话导致），
      // 禁止改密：否则会把旧凭证永久遗留为新密码无法解密的孤儿数据（后端已同步拒绝）。
      if (!this.creds && this.hasCreds) {
        throw new Error("当前无法解密已保存的 OSS 凭证，请先在「设置」重新配置并保存凭证后，再修改密码")
      }
      // 先用新密码派生密钥把 OSS 凭证重新加密，与改密在同一请求/事务内原子提交，
      // 避免“密码已改但凭证未加密”导致修改密码后无法解密
      const newEncryptedCreds =
        this.creds && oldKey ? await encryptCreds(newKey, this.creds) : null
      await api.changePassword({
        oldPasswordHash: oldVerifier,
        newPasswordHash: newVerifier,
        newEncryptedCreds,
      })
      this.userKey = newKey
      if (getSavedPassword()) savePassword(newPassword)
    },
    async logout() {
      const username = this.username
      try {
        await api.logout()
      } catch {
        /* ignore */
      }
      // 先尽量落盘未保存变更，再清空内存，避免上次操作丢失或污染下一个账号。
      // 保存失败不阻塞登出：即使 OSS 写失败也必须完成清空与跳转（BUG-24/39）
      const { useTasksStore } = await import('./tasks')
      const { useProjectsStore } = await import('./projects')
      const { useStatsStore } = await import('./stats')
      await Promise.allSettled([
        useTasksStore().flushAll(),
        useProjectsStore().flushProfile(),
        useStatsStore().flush(),
      ])
      // 尽力把待发变更上报发给中心服务器（队列按用户隔离，登出时保留、下次登录补报）
      await flushPendingSyncReports(username)
      // 登出同样销毁隐私日记内存密钥/解密态与空闲锁（每个账号日记独立，换账号不得残留）
      const { useDiaryStore } = await import('./diary')
      useDiaryStore().lock()
      this.reset()
      useTasksStore().resetAll()
      useProjectsStore().resetAll()
      useStatsStore().resetAll()
      // 登出后清除该用户在本地的全部缓存，避免旧数据残留：
      // 下次登录一律以云端为权威，防止把过期数据当成本地数据展示或再次同步回云端造成冲突
      await idbClearUserCache(username)
    },
    /** 刷新/重启后从持久化用户名恢复内存态：自动解锁与 401 自动恢复都依赖 username */
    restoreUser() {
      if (!this.username) this.username = getSavedUsername()
    },

    /** 注册 401 自动恢复钩子：会话过期/被挤下线时，用记住的密码静默重登，避免强制重新输入密码。
     *  登出（token 被清）后不再自动尝试，防止“记住的密码已失效”时反复重试导致账号被锁定。 */
    registerRestoreHook() {
      setUnauthorizedRestoreHook(async () => {
        if (!getToken()) return false
        if (!this.username) this.username = getSavedUsername()
        return this.tryAutoUnlock()
      })
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
