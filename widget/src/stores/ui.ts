import { defineStore } from 'pinia'

export interface OssErrorInfo {
  title: string
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

/** 桌面小组件的极简 UI store：toast 用 console 兜底（小组件内不显示 toast 层），
 *  OSS 错误信息记录到内存，供界面上方错误条展示。 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: [] as Toast[],
    ossError: null as OssErrorInfo | null,
  }),
  actions: {
    showOssError(info: OssErrorInfo) {
      this.ossError = info
      console.warn('[widget] OSS 错误：', info.title, info.hint)
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
    dismiss(id: number) {
      this.toasts = this.toasts.filter((t) => t.id !== id)
    },
  },
})
