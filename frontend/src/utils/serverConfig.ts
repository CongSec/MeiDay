/**
 * 服务器地址管理（运行时可切换，本地保存）
 *
 * - 官方地址（打包默认 VITE_API_BASE_URL，未设置时回退 https://task.congsec.cn）固定置顶、不可删除
 * - 用户可添加/删除自定义服务器地址，点选切换，本地保存在 localStorage
 * - 切换服务器时由登录页负责清空登录态，避免旧服务器的 token/记住密码发往新服务器
 * - 思源插件端口变化 / localStorage 被清时，插件会把服务器配置镜像到 plugin.storage 并在
 *   父窗口挂 __meiday_config，此处 seedFromParentConfig 负责把它灌回 localStorage
 */

const OFFICIAL_SERVER = 'https://task.congsec.cn'
/** 构建时注入的默认地址：生产构建（APP/插件/小组件）= 官方；开发模式为空 = 走同源代理 */
const BUILTIN_SERVER = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')

export const SERVERS_KEY = 'st_servers'
export const ACTIVE_KEY = 'st_server_active'

export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** 固定置顶的官方默认服务器（不可删除） */
export function getOfficialServer(): string {
  return OFFICIAL_SERVER
}

/** 构建时注入的默认地址（生产=官方，开发=''=同源） */
export function getBuiltinServer(): string {
  return BUILTIN_SERVER
}

function readServers(): string[] {
  try {
    const raw = localStorage.getItem(SERVERS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((u) => normalizeServerUrl(String(u))).filter(Boolean)
  } catch {
    return []
  }
}

function writeServers(list: string[]): void {
  try {
    localStorage.setItem(SERVERS_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式等存储不可用时仅影响“记住服务器列表” */
  }
}

/** 用户自定义服务器列表（不含官方固定项） */
export function getSavedServers(): string[] {
  return readServers()
}

export function addServer(raw: string): { ok: boolean; error?: string; url?: string; list: string[] } {
  const url = normalizeServerUrl(raw)
  if (!/^https?:\/\/.+/.test(url)) {
    return { ok: false, error: '服务器地址需以 http:// 或 https:// 开头', list: readServers() }
  }
  const list = readServers()
  if (!list.includes(url)) {
    list.push(url)
    writeServers(list)
  }
  return { ok: true, url, list }
}

export function removeServer(raw: string): string[] {
  const url = normalizeServerUrl(raw)
  const list = readServers().filter((u) => u !== url)
  writeServers(list)
  if (getActiveServer() === url) {
    // 删除当前选中项：回落到构建默认（生产=官方；开发=同源代理）
    try {
      localStorage.removeItem(ACTIVE_KEY)
    } catch {
      /* ignore */
    }
  }
  return list
}

/** 当前选中（UI 高亮）：自定义 active > 构建默认 > 官方 */
export function getActiveServer(): string {
  try {
    const active = localStorage.getItem(ACTIVE_KEY)
    if (active) return active
  } catch {
    /* ignore */
  }
  return BUILTIN_SERVER || OFFICIAL_SERVER
}

export function setActiveServer(raw: string): void {
  const url = normalizeServerUrl(raw)
  if (!url) return
  try {
    localStorage.setItem(ACTIVE_KEY, url)
  } catch {
    /* ignore */
  }
  // 自定义地址同时记入保存列表；官方/构建默认不重复进列表
  if (url !== OFFICIAL_SERVER && url !== BUILTIN_SERVER) addServer(url)
}

/** 运行时 API 基址：自定义 active > 构建默认；开发模式为空 = 同源代理 */
export function getApiBase(): string {
  try {
    const active = localStorage.getItem(ACTIVE_KEY)
    if (active) return active
  } catch {
    /* ignore */
  }
  return BUILTIN_SERVER
}

/** 健康探测结果分类 */
export type HealthKind = 'ok' | 'timeout' | 'http' | 'cors' | 'network' | 'unknown'

export interface HealthResult {
  ok: boolean
  kind: HealthKind
  /** 服务器有响应时的 HTTP 状态码（kind='http' 时存在） */
  status?: number
  /** 原始错误信息（仅调试用） */
  detail?: string
}

/** 带超时的单次探测：目标服务器返回任意 HTTP 响应即视为「可达」 */
async function probeOnce(base: string, timeoutMs: number): Promise<{ reachable: boolean; status?: number; aborted?: boolean }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal, cache: 'no-store' })
    return { reachable: true, status: res.status }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { reachable: false, aborted: true }
    return { reachable: false }
  } finally {
    clearTimeout(timer)
  }
}

/** 探测服务器是否可用：GET /api/health，返回分类结果（timeout/cors/network/http…） */
export async function checkServerHealth(raw: string, timeoutMs = 6000): Promise<HealthResult> {
  const base = normalizeServerUrl(raw)
  if (!base) return { ok: false, kind: 'unknown', detail: 'empty url' }
  const first = await probeOnce(base, timeoutMs)
  if (first.reachable) {
    if (first.status !== undefined && first.status >= 200 && first.status < 300) {
      return { ok: true, kind: 'ok', status: first.status }
    }
    return { ok: false, kind: 'http', status: first.status }
  }
  // 首次失败（网络层或 CORS）。用 no-cors 模式再探一次：
  // - no-cors 成功（opaque）→ 服务器可达，是 CORS 拦截了正常请求；
  // - no-cors 也失败→ 网络层不可达（未启动/地址端口错/防火墙/不在同一网络）。
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.min(4000, timeoutMs))
    try {
      await fetch(`${base}/api/health`, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' })
      return { ok: false, kind: 'cors', detail: 'reachable-but-cors' }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return first.aborted
      ? { ok: false, kind: 'timeout', detail: 'aborted' }
      : { ok: false, kind: 'network', detail: 'unreachable' }
  }
}

/** 把健康探测失败结果转成用户可读的中文说明（不含「是否保存/切换」问句） */
export function describeServerProblem(r: HealthResult, url = ''): string {
  const target = url || ''
  switch (r.kind) {
    case 'timeout':
      return `连接超时：服务器在 6 秒内无响应${target ? `（${target}）` : ''}。请确认服务器已启动、地址和端口正确，且设备与服务器在同一网络。`
    case 'http':
      return `服务器已响应，但返回异常状态码 ${r.status ?? '未知'}（期望 200）。请确认填的是 MeiDay 后端地址（包含 /api/health 接口）。`
    case 'cors':
      return `服务器可达，但拒绝了来自本应用的跨域请求（CORS）。请在服务器后台把源 ${typeof window !== 'undefined' && window.location ? window.location.origin : ''} 加入允许列表后重试。`
    case 'network':
      return `无法连接到服务器${target ? `（${target}）` : ''}：可能是地址或端口错误、服务器未启动、防火墙拦截，或设备与服务器不在同一网络。`
    default:
      return `该服务器暂时无法访问。`
  }
}

/** 快照当前服务器配置（供插件/小组件镜像持久化） */
export function snapshotServerConfig(): { servers: string[]; active: string } {
  return { servers: readServers(), active: getActiveServer() }
}

/** 用外部来源（插件 plugin.storage / 小组件 config.json）的配置覆盖本地 */
export function importServerConfig(servers: string[], active: string): void {
  const list = Array.isArray(servers) ? servers.map(normalizeServerUrl).filter(Boolean) : []
  writeServers(list)
  try {
    if (active) localStorage.setItem(ACTIVE_KEY, active)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* ignore */
  }
}

/** 思源插件双保险：插件把服务器配置镜像到 plugin.storage 并在父窗口挂 __meiday_config，
 *  思源端口变化 / localStorage 被清时，把配置灌回 localStorage。Web / APK 无该全局，自动跳过。 */
export function seedFromParentConfig(): void {
  if (typeof window === 'undefined') return
  try {
    const c = (window.parent as unknown as { __meiday_config?: { servers?: string[]; active?: string } }).__meiday_config
    if (!c) return
    const hasLocal = !!localStorage.getItem(SERVERS_KEY) || !!localStorage.getItem(ACTIVE_KEY)
    if (!hasLocal) {
      importServerConfig(c.servers ?? [], c.active ?? '')
    }
  } catch {
    /* 非插件环境（跨源 iframe 等）读取失败时忽略 */
  }
}

/** 检测当前页面是否因浏览器「混合内容」策略无法访问 http:// 目标：
 *  HTTPS 页面 → HTTP 地址会被浏览器硬拦截（网页端 HTTPS 部署时，自定义 http:// 服务器不可用）。
 *  原生 APP 已开启 Capacitor allowMixedContent，不视为拦截；小组件/插件页面非 HTTPS，也不受影响。
 *  思源插件（/挂件）把 MeiDay 前端以 iframe 内嵌，iframe 内不存在浏览器「混合内容」硬拦截，
 *  http:// 地址在插件端实测可用，因此 iframe 环境（非顶层网页）一律不弹「网页端限制」警告。 */
export function isMixedContentBlocked(target: string): boolean {
  try {
    if (typeof window === 'undefined' || window.location.protocol !== 'https:') return false
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return false
    // 思源插件/挂件等 iframe 内嵌场景：浏览器不会对 http:// 发起混合内容拦截，http 可用，
    // 不应弹出「当前网页是 HTTPS…网页端无法使用」这类网页端专属提示。
    // 真正的网页端是顶层窗口（window.self === window.top），才会命中下面的混合内容判断。
    if (window.self !== window.top) return false
    return /^http:\/\//i.test(normalizeServerUrl(target))
  } catch {
    return false
  }
}
