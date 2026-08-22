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
  region: string
}

export interface Toast {
  id: number
  text: string
  type: 'ok' | 'error'
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
      this.ossError = info
    },
    closeOssError() {
      this.ossError = null
    },
    toast(text: string, type: 'ok' | 'error' = 'ok') {
      const id = Date.now() + Math.random()
      this.toasts.push({ id, text, type })
      window.setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }, 2600)
    },
  },
})
