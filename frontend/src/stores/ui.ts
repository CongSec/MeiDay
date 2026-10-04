import { defineStore } from 'pinia'

export interface OssErrorInfo {
  title: string
  /** 用户可读的中文提示（describeOssError fallback） */
  hint: string
  code: string | null
  status: number | null
  message: string | null
  request_id: string | null
  cors_configured: boolean | null
  bucket: string
  endpoint: string
}

export interface Toast {
  id: number
  text: string
  type: 'ok' | 'error'
}

/** 全局提示去重窗口（毫秒）：相同文案在此窗口内只显示一次，避免多端冲突类提示反复刷屏 */
const TOAST_DEDUP_MS = 5000
/** 各文案最近一次显示的毫秒时间戳 */
const lastToastShownAt = new Map<string, number>()

/**
 * OSS 错误弹窗去重窗口（毫秒）：相同错误在窗口内不重复弹窗。
 * 弱网/后台同步轮询失败时会连续触发同一 OSS 错误，不节流的话弹窗会反复打断用户。
 */
const OSS_ERROR_DEDUP_MS = 15_000
/** 最近一次弹窗的 OSS 错误指纹与时间戳 */
let lastOssErrorKey = ''
let lastOssErrorAt = 0

function ossErrorKey(info: OssErrorInfo): string {
  return `${info.title}|${info.hint}|${info.code ?? ''}|${info.status ?? ''}`
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    drawerOpen: false,
    toasts: [] as Toast[],
    ossError: null as OssErrorInfo | null,
  }),
  actions: {
    openDrawer() {
      this.drawerOpen = true
    },
    closeDrawer() {
      this.drawerOpen = false
    },
    showOssError(info: OssErrorInfo) {
      const key = ossErrorKey(info)
      const now = Date.now()
      // 相同 OSS 错误去重：窗口内不重复弹窗（避免同步轮询失败反复打断用户）
      if (key === lastOssErrorKey && now - lastOssErrorAt < OSS_ERROR_DEDUP_MS) return
      lastOssErrorKey = key
      lastOssErrorAt = now
      this.ossError = info
    },
    closeOssError() {
      this.ossError = null
    },
    toast(text: string, type: 'ok' | 'error' = 'ok') {
      const now = Date.now()
      const lastShownAt = lastToastShownAt.get(text) ?? 0
      // 全局提示去重：相同文案 5 秒内只显示一次，避免多端冲突类提示反复刷屏
      if (now - lastShownAt < TOAST_DEDUP_MS) return
      lastToastShownAt.set(text, now)
      const id = now + Math.random()
      this.toasts.push({ id, text, type })
      window.setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }, 2600)
    },
    dismiss(id: number) {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    },
  },
})

