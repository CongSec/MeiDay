import {
  getSavedPassword, getSavedPasswordAt, getSavedUsername, getToken, getTokenAt,
  setSavedPasswordRaw, setSavedUsernameRaw, setTokenRaw,
} from '@/api/client'

/**
 * 桌面小组件与 Python 壳之间的配置桥接。
 * config.json 固定存放于程序同级目录（Python 端管理），结构：
 *   { session: {token, tokenAt, savedPw, savedPwAt, username},
 *     widget:  {opacity, width, posX, posY, autoStart, fontSize} }
 * 登录态在 localStorage（同步访问）与 config.json（持久化）之间镜像。
 */

export interface SessionConfig {
  token: string
  tokenAt: number
  savedPw: string
  savedPwAt: number
  username: string
}

export interface WidgetConfig {
  opacity: number
  width: number
  /** 屏幕位置（逻辑像素，可空：未手动拖动过则为 null，启动时贴右） */
  posX: number | null
  posY: number | null
  autoStart: boolean
  /** 任务文字基准字号（px） */
  fontSize: number
}

export interface AppConfig {
  session: SessionConfig
  widget: WidgetConfig
}

export function pvApi(): any {
  return (window as any).pywebview?.api
}

const emptySession = (): SessionConfig => ({
  token: '',
  tokenAt: 0,
  savedPw: '',
  savedPwAt: 0,
  username: '',
})

const defaultWidget = (): WidgetConfig => ({
  opacity: 0.6,
  width: 360,
  posX: null,
  posY: null,
  autoStart: false,
  fontSize: 16,
})

export async function readConfig(): Promise<AppConfig> {
  const api = pvApi()
  if (api?.read_config) {
    try {
      const raw = await api.read_config()
      const session = { ...emptySession(), ...(raw?.session ?? {}) }
      const widget = { ...defaultWidget(), ...(raw?.widget ?? {}) }
      return { session, widget }
    } catch {
      /* 忽略，走默认 */
    }
  }
  return { session: emptySession(), widget: defaultWidget() }
}

export async function writeSession(patch: Partial<SessionConfig>): Promise<void> {
  const api = pvApi()
  if (api?.write_config) {
    try {
      await api.write_config({ session: patch })
    } catch {
      /* 忽略 */
    }
  }
}

export async function writeWidget(patch: Partial<WidgetConfig>): Promise<void> {
  const api = pvApi()
  if (api?.write_config) {
    try {
      await api.write_config({ widget: patch })
    } catch {
      /* 忽略 */
    }
  }
}

/** 启动时把 config.json 里的登录态灌回 localStorage（供 auth store 同步读取）。 */
export async function seedSessionFromConfig(): Promise<void> {
  const cfg = await readConfig()
  const s = cfg.session
  if (s.token) setTokenRaw(s.token, s.tokenAt || Date.now())
  if (s.savedPw) setSavedPasswordRaw(s.savedPw, s.savedPwAt || Date.now())
  if (s.username) setSavedUsernameRaw(s.username)
}

/** 把当前 localStorage 登录态快照成 SessionConfig。 */
export function snapshotSessionToConfig(): SessionConfig {
  return {
    token: getToken(),
    tokenAt: getTokenAt(),
    savedPw: getSavedPassword(),
    savedPwAt: getSavedPasswordAt(),
    username: getSavedUsername(),
  }
}

/** 登录/登出/自动解锁后调用：把 localStorage 登录态持久化到 config.json。 */
export async function persistSessionToConfig(): Promise<void> {
  await writeSession(snapshotSessionToConfig())
}

