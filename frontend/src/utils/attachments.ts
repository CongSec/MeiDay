import { createOssClient, describeOssError, paths } from './oss'
import { nowIso } from './time'
import type { AttachmentMeta, CredFields } from '@/types'

/** 单个附件上传的总超时：防止 OSS 请求因弱网/挂起而无限等待，导致“一直显示正在上传中” */
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && /上传超时/.test(e.message)
}

/** 给 promise 加超时：超时后 reject（底层请求可能仍在进行，失败不影响业务） */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`上传超时（${Math.round(ms / 1000)} 秒内无响应）`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 上传一个附件到用户 OSS：浏览器直传（不经服务器），原始字节不加密；
 *  元数据（id/名称/大小/类型/OSS key）存于任务/子任务 JSON。 */
export async function uploadAttachment(
  creds: CredFields,
  username: string,
  taskId: string,
  file: File,
): Promise<AttachmentMeta> {
  const id = crypto.randomUUID()
  const client = await createOssClient(creds)
  const key = paths.attachment(username, taskId, id)
  // 原始文件直传，Content-Type 保持文件原始类型（便于直接预览 / 下载）
  // 加总超时与统一错误文案：避免弱网/挂起时一直停在“上传中”
  try {
    await withTimeout(client.put(key, file), UPLOAD_TIMEOUT_MS)
  } catch (e) {
    throw new Error(isTimeoutError(e) ? "附件上传超时，请检查网络后重试" : describeOssError(e))
  }
  return {
    id,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    key,
    uploadedAt: nowIso(),
  }
}

/** 下载附件原始字节，返回带原始 MIME 类型的 Blob（无需解密，供预览 / 下载） */
export async function downloadAttachment(
  creds: CredFields,
  meta: AttachmentMeta,
): Promise<Blob> {
  const client = await createOssClient(creds)
  const res = await client.get(meta.key)
  const bytes = await new Blob([res.content]).arrayBuffer()
  return new Blob([bytes], { type: meta.type || 'application/octet-stream' })
}

/** 从用户 OSS 删除单个附件二进制 */
async function deleteAttachment(creds: CredFields, meta: AttachmentMeta): Promise<void> {
  const client = await createOssClient(creds)
  try {
    await client.delete(meta.key)
  } catch {
    /* 删除失败不影响业务（孤文件可由用户自行清理） */
  }
}

/** 批量删除附件二进制 */
export async function deleteAttachments(
  creds: CredFields,
  list: AttachmentMeta[] | undefined,
): Promise<void> {
  for (const a of list ?? []) await deleteAttachment(creds, a)
}

/** 允许用 <img> 内联渲染的安全位图格式（不含 SVG 等可内嵌脚本的矢量/XML 格式）。
 *  仅这些 MIME/扩展名才会走图片预览，避免 SVG/HTML 混装在图片标签里触发脚本执行。 */
const SAFE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])
const SAFE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico']
const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf'])
const PDF_EXT = 'pdf'

/** 附件的安全预览方式：
 *  - 'image'：可安全内联显示（<img>）的位图格式；
 *  - 'pdf'：PDF 文档，必须放进 sandbox 隔离的 <iframe>（配合强制 application/pdf MIME）预览；
 *  - null：不支持或不安全（SVG/HTML/DOCX 等），仅提供下载，绝不内联渲染。
 *
 *  安全原则：任何可能被浏览器当作 HTML/脚本渲染的内容（SVG、HTML、伪装成 PDF 的脚本文件等）
 *  都不允许内联预览；文件扩展名与 MIME 都通过白名单校验，防止内容嗅探导致 XSS。 */


export function previewKind(meta: AttachmentMeta): 'image' | 'pdf' | null {
  const type = (meta.type || '').toLowerCase()
  const dot = meta.name.lastIndexOf('.')
  const ext = dot >= 0 ? meta.name.slice(dot + 1).toLowerCase() : ''

  // 1) 声明类型是明确的安全位图 / PDF：直接决定渲染方式
  if (SAFE_IMAGE_TYPES.has(type)) return 'image'
  if (PDF_TYPES.has(type)) return 'pdf'

  // 2) 类型为空 / 通用二进制（无法判定内容）：仅按扩展名白名单兜底
  //    （兼容 file.type 缺失或为 application/octet-stream 的文件）
  const unknown = type === '' || type === 'application/octet-stream'
  if (unknown) {
    if (SAFE_IMAGE_EXTS.includes(ext)) return 'image'
    if (ext === PDF_EXT) return 'pdf'
  }

  // 3) 其它任何声明类型（text/html、image/svg+xml、text/xml 等）一律不预览：
  //    防止浏览器按扩展名/内容嗅探成 HTML 执行脚本（存储型 XSS）。
  return null
}

/** 图片 / PDF 支持在线预览，其余格式走下载（SVG 等危险格式一律不预览） */
export function isPreviewable(meta: AttachmentMeta): boolean {
  return previewKind(meta) !== null
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
