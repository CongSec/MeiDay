const TOKEN_KEY = 'st_token'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 桌面小组件：通过 VITE_API_BASE_URL 指向后端地址（构建时注入 https://task.congsec.cn） */
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(`${TOKEN_KEY}_at`, String(Date.now()))
  unauthorizedFired = false
  restoreFailedOnce = false
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(`${TOKEN_KEY}_at`)
}

function tokenAgeMs(): number {
  const at = Number(localStorage.getItem(`${TOKEN_KEY}_at`) ?? 0)
  return at ? Date.now() - at : 0
}

function isTokenExpiredLocal(): boolean {
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

const USER_KEY = 'st_user'

export function saveUsername(username: string): void {
  localStorage.setItem(USER_KEY, username)
}

export function getSavedUsername(): string {
  return localStorage.getItem(USER_KEY) ?? ''
}

export function clearSavedUsername(): void {
  localStorage.removeItem(USER_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 401 跳登录事件去重：同一页面生命周期内只触发一次 */
let unauthorizedFired = false
function fireUnauthorized(): void {
  if (unauthorizedFired) return
  unauthorizedFired = true
  window.dispatchEvent(new CustomEvent('st:unauthorized'))
}

/** 401 自动恢复钩子：由 auth store 注册，用“记住的密码”静默重新登录 */
export type UnauthorizedRestoreHook = () => Promise<boolean>
let restoreHook: UnauthorizedRestoreHook | null = null
export function setUnauthorizedRestoreHook(hook: UnauthorizedRestoreHook | null): void {
  restoreHook = hook
}

let restorePromise: Promise<boolean> | null = null
let restoreFailedOnce = false
async function attemptRestore(): Promise<boolean> {
  if (restoreFailedOnce) return false
  if (restorePromise) return restorePromise
  restorePromise = (async () => {
    try {
      return restoreHook ? await restoreHook() : false
    } catch {
      return false
    }
  })()
  try {
    const ok = await restorePromise
    if (!ok) restoreFailedOnce = true
    return ok
  } finally {
    restorePromise = null
  }
}

interface RequestOpts {
  retried?: boolean
  restoreOn401?: boolean
}
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  tokenOverride?: string,
  opts?: RequestOpts,
): Promise<T> {
  const { retried = false, restoreOn401 = true } = opts ?? {}
  if (!tokenOverride && isTokenExpiredLocal()) {
    clearToken()
    clearSavedPassword()
    fireUnauthorized()
    throw new ApiError(401, '登录已过期，请重新登录')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = tokenOverride ?? getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_BASE}${path}`, {
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
      if (restoreOn401 && !retried) {
        const restored = await attemptRestore()
        if (restored) return request<T>(method, path, body, undefined, { retried: true, restoreOn401 })
      }
      clearToken()
      fireUnauthorized()
    }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

export interface MeResponse {
  username: string
  hasCreds: boolean
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

/** 同步协调中心：客户端可上报的资源类型（与各 store 一一对应） */
export type SyncResType = 'profile' | 'tasks' | 'trash' | 'repeats' | 'stats' | 'today_order'
export interface SyncChangeItem {
  res_type: SyncResType
  project_id?: string | null
}
export interface SyncStateItem {
  id: number
  res_type: string
  project_id: string | null
  ts: string
}
export interface SyncState {
  version: number
  /** true 表示本地版本落后过多（服务端事件已被清理），应全量同步 */
  full_sync: boolean
  changes: SyncStateItem[]
}

export const api = {
  login(body: { username: string; passwordHash: string }, tokenOverride?: string) {
    return request<LoginResponse>('POST', '/api/login', body, tokenOverride, { restoreOn401: false })
  },
  logout() {
    return request<{ ok: true }>('POST', '/api/logout')
  },
  me() {
    return request<MeResponse>('GET', '/api/me')
  },
  checkOss(body: { oss_ak: string; oss_sk: string; bucket: string; endpoint: string }) {
    return request<OssCheckResult>('POST', '/api/credentials/oss-check', body)
  },
  reportSyncChanges(events: SyncChangeItem[]) {
    return request<{ ok: true; version: number }>('POST', '/api/sync/report', { events })
  },
  getSyncState(since = 0) {
    return request<SyncState>('GET', `/api/sync/state?since=${since}`)
  },
}
