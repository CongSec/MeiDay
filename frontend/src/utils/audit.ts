import { api, getToken } from '@/api/client'
import { formatSize } from './attachments'

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

/** 附件删除日志：单个被删附件的 OSS 文件名（key 末段 UUID，便于与控制台核对）+ 其对应任务名（孤儿/未保存留空） */
export interface AttachmentDeletionFile {
  name: string
  /** 附件对应的任务名；孤儿（上传未保存等无对应任务）为空 */
  taskName: string
}

/** 附件删除日志：一次删除操作（可能含多个附件）的汇总信息 */
export interface AttachmentDeletionInfo {
  /** 来源：资源图 / 任务编辑 / 永久删除任务 / 删除子任务 / 上传清理 / 清空时间胶囊 */
  source: string
  /** 本次删除（或发起删除）的附件数 */
  count: number
  /** 其中孤儿（无对应任务）数量 */
  orphanCount: number
  /** 删除失败数量（>0 时才写入详情） */
  failed?: number
  /** 总大小（字节） */
  totalSize: number
  /** 文件名 + 任务名列表（仅前若干条写入详情，超长截断） */
  files: AttachmentDeletionFile[]
}

/** 后端 ClientLogRequest.detail 上限 500 字符（schemas.py），客户端留余量截断 */
const ATTACH_DELETE_DETAIL_MAX = 480
/** 详情里最多展示的文件条数 */
const ATTACH_DELETE_FILES_SHOWN = 6

/**
 * 附件删除日志：所有删除入口统一行为名「删除附件」，来源与汇总写进详情
 * （含任务名，文本结构清晰，为将来日志搜索留基础）。与 logAudit 一致：失败静默、不阻断业务。
 */
export function logAttachmentDeletion(info: AttachmentDeletionInfo): void {
  if (!info.count && !info.failed) return
  const refCount = Math.max(0, info.count - info.orphanCount)
  const parts: string[] = [
    `来源：${info.source}`,
    `删除 ${info.count} 个附件（孤儿 ${info.orphanCount} / 引用 ${refCount}）`,
    `总大小 ${formatSize(info.totalSize)}`,
  ]
  const shown = info.files.slice(0, ATTACH_DELETE_FILES_SHOWN)
  if (shown.length) {
    const list = shown
      .map((f) => (f.taskName ? `${f.name}@${f.taskName}` : `${f.name}（无对应任务）`))
      .join('；')
    const more = info.files.length > shown.length ? `…等 ${info.files.length} 个` : ''
    parts.push(`文件：${list}${more}`)
  }
  if (info.failed) parts.push(`失败 ${info.failed} 个`)
  logAudit('删除附件', safeDetail(parts.join('｜'), ATTACH_DELETE_DETAIL_MAX))
}
