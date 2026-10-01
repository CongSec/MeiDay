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
