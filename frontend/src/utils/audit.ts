import { api, getToken } from '@/api/client'

/**
 * 客户端行为上报：任务/项目增删改、打开回收站/设置、显示密钥等。
 * 失败静默（不阻断用户操作）。
 * 未登录（本地无 token）时不发送：/api/logs/client 需要鉴权，未登录时发送只会
 * 产生一串 401 无效请求，且不会在任务系统中留下任何审计记录。
 */
export function logAudit(action: string, detail = ''): void {
  if (!action) return
  // 未登录直接不发送，避免对后端产生无效请求风暴（未登录页面大量 POST /api/logs/client）
  if (!getToken()) return
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
