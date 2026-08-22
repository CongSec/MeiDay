const TOKEN_KEY = 'st_token'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(`${TOKEN_KEY}_at`, String(Date.now()))
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(`${TOKEN_KEY}_at`)
}

export function tokenAgeMs(): number {
  const at = Number(localStorage.getItem(`${TOKEN_KEY}_at`) ?? 0)
  return at ? Date.now() - at : 0
}

export function isTokenExpiredLocal(): boolean {
  return !!getToken() && tokenAgeMs() > SESSION_TTL_MS
}

const SAVED_PW_KEY = 'st_saved_pw'
const SAVED_PW_AT_KEY = 'st_saved_pw_at'
const SAVED_PW_TTL_MS = SESSION_TTL_MS

export function savePassword(pw: string): void {
  localStorage.setItem(SAVED_PW_KEY, pw)
  localStorage.setItem(SAVED_PW_AT_KEY, String(Date.now()))
}

export function getSavedPassword(): string {
  const at = Number(localStorage.getItem(SAVED_PW_AT_KEY) ?? 0)
  if (!at) return ''
  if (Date.now() - at > SAVED_PW_TTL_MS) {
    clearSavedPassword()
    return ''
  }
  return localStorage.getItem(SAVED_PW_KEY) ?? ''
}

export function clearSavedPassword(): void {
  localStorage.removeItem(SAVED_PW_KEY)
  localStorage.removeItem(SAVED_PW_AT_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 本地会话过期（7 天未活动）：直接视为未认证，清理本地态并跳登录。
  // 让 isTokenExpiredLocal/tokenAgeMs 真正生效，避免“本地已过期仍发请求”（BUG-36）
  if (isTokenExpiredLocal()) {
    clearToken()
    clearSavedPassword()
    window.dispatchEvent(new CustomEvent('st:unauthorized'))
    throw new ApiError(401, '登录已过期，请重新登录')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = await res.json()
      if (typeof j.detail === 'string') msg = j.detail
    } catch {
      /* ignore */
    }
    if (res.status === 401) {
      clearToken()
      window.dispatchEvent(new CustomEvent('st:unauthorized'))
    }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

export interface SmtpPlain {
  smtp_user: string
  smtp_pass: string
  notify_email: string
}

export interface MeResponse {
  username: string
  hasCreds: boolean
}

export interface NotifyPrefs {
  login_success: boolean
  login_failed: boolean
  key_view: boolean
}

export interface LoginResponse {
  sessionToken: string
  encrypted_creds: string | null
}

export interface OssCheckResult {
  ok: boolean
  cors_configured: boolean | null
  code: string | number | null
  status: number | null
  message: string | null
  request_id: string | null
}
export interface AuditLog {
  id: number
  created_at: string
  username: string | null
  action: string
  method: string
  path: string
  status: number | null
  ip: string
  user_agent: string
  detail: string
  duration_ms: number | null
  /** 安全相关记录（如密码登录失败）重点标注 */
  is_security: number
  /** 高危操作（如“显示密钥”）显眼标注 */
  is_high_risk: number
}

export const api = {
  /** 注册只发送 SHA-256(password) 校验子（不可逆密文），明文密码不出浏览器 */
  register(body: { username: string; passwordHash: string; encrypted_creds?: string | null; smtp_plain?: SmtpPlain | null }) {
    return request<{ ok: true }>('POST', '/api/register', body)
  },
  /** 登录只发送 SHA-256(password) 校验子（不可逆密文），明文密码不出浏览器 */
  login(body: { username: string; passwordHash: string }) {
    return request<LoginResponse>('POST', '/api/login', body)
  },
  /** 旧账号一次性迁移登录：仅 auth_version=0 的历史账号首次登录时发送一次明文密码 */
  legacyLogin(body: { username: string; password: string }) {
    return request<LoginResponse>('POST', '/api/login/legacy', body)
  },
  logout() {
    return request<{ ok: true }>('POST', '/api/logout')
  },
  me() {
    return request<MeResponse>('GET', '/api/me')
  },
  updateCredentials(body: { encrypted_creds: string; smtp_plain?: SmtpPlain | null }) {
    return request<{ ok: true }>('PUT', '/api/credentials', body)
  },
  /** 修改密码：只发送 SHA-256 校验子（不可逆密文），明文密码不出浏览器。
   *  newEncryptedCreds 为用新密码派生密钥重加密后的凭证密文，与改密原子提交。 */
  changePassword(body: { oldPasswordHash: string; newPasswordHash: string; newEncryptedCreds?: string | null }) {
    return request<{ ok: true }>('POST', '/api/change-password', body)
  },
  syncReminders(tasks: { id: string; name: string; description: string; startTime: string | null; endTime: string | null; reminderTime: string | null; projectId: string; status: string; isReminded: boolean; subtaskId?: string; /** 重复提醒规则：服务器只存这一条规则，发完邮件后自行按周期推进 */ repeatRule?: { type: string; interval: number; weekdays?: number[]; monthDay?: number; endAfter?: string } }[], projectIds: string[]) {
    return request<{ ok: true; count: number }>('PUT', '/api/reminders/sync', { tasks, projectIds })
  },
  /** 后端直连 OSS 诊断（绕过浏览器 CORS），返回真实错误码（如 NoSuchBucket）。
   *  AK/SK 仅用于本次诊断，后端不落库、不打印。 */
  checkOss(body: { oss_ak: string; oss_sk: string; bucket: string; region: string }) {
    return request<OssCheckResult>('POST', '/api/credentials/oss-check', body)
  },
  getLogs(params: { action?: string; ip?: string; limit?: number; offset?: number } = {}) {
    const qs = new URLSearchParams()
    if (params.action) qs.set('action', params.action)
    if (params.ip) qs.set('ip', params.ip)
    qs.set('limit', String(params.limit ?? 100))
    qs.set('offset', String(params.offset ?? 0))
    return request<{ total: number; offset: number; limit: number; items: AuditLog[] }>(
      'GET',
      `/api/logs?${qs.toString()}`,
    )
  },
  getLogActions() {
    return request<{ items: { action: string; count: number }[] }>('GET', '/api/logs/actions')
  },
  /** 上报前端行为（任务/项目增删改、打开回收站/设置、显示密钥等） */
  logClient(action: string, detail = '') {
    return request<{ ok: true }>('POST', '/api/logs/client', { action, detail })
  },
  /** 清空当前登录用户自己的日志（不影响其他用户） */
  deleteAllLogs() {
    return request<{ ok: true; deleted: number }>('DELETE', '/api/logs/all')
  },
  /** 安全邮件通知开关（登录成功 / 登录失败 / 查看密钥） */
  getNotifyPrefs() {
    return request<NotifyPrefs>('GET', '/api/notify-prefs')
  },
  setNotifyPrefs(body: { login_success?: boolean; login_failed?: boolean; key_view?: boolean }) {
    return request<NotifyPrefs>('PUT', '/api/notify-prefs', body)
  },
  getLogRetention() {
    return request<{ days: number; defaultDays: number; minDays: number; maxDays: number }>(
      'GET',
      '/api/settings/log-retention',
    )
  },
  setLogRetention(days: number) {
    return request<{ ok: true; days: number }>('PUT', '/api/settings/log-retention', { days })
  },
}
