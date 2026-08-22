import { api } from '@/api/client'

/**
 * 客户端行为上报：任务/项目增删改、打开回收站/设置、显示密钥等。
 * 失败静默（不阻断用户操作）；无登录态/未配置凭证时不发送。
 */
export function logAudit(action: string, detail = ''): void {
  if (!action) return
  void api
    .logClient(action, detail)
    .catch(() => {
      /* 日志上报失败不影响业务 */
    })
}

/** 截断过长的详情，避免无效请求 */
export function safeDetail(text: string, max = 200): string {
  if (!text) return ''
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}
