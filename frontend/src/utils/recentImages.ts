import { Capacitor, registerPlugin } from '@capacitor/core'

/** 与原生 RecentImagesPlugin 的返回结构对应 */
export interface RecentImageData {
  /** 图片 MIME，如 image/png */
  mime: string
  /** 图片字节数（大图已由原生降采样重编码） */
  size: number
  /** 图片字节的 base64（无换行） */
  base64: string
  /** 相册里的原文件名 */
  name: string
  /** 图片新增时间（epoch 秒），用于去重 */
  dateAdded: number
}

interface RecentImagesPluginShape {
  listRecentImages(options: { maxAgeSeconds: number; limit: number }): Promise<{
    permissionDenied?: boolean
    items?: RecentImageData[]
  }>
}

const RecentImages = registerPlugin<RecentImagesPluginShape>('RecentImages')

/** “新鲜图片”窗口：超过该时长（截图/拍照）就不再提示 */
export const IMAGE_MAX_AGE_SECONDS = 180
/** 提示条里最多展示的缩略图张数，超出显示「+N」 */
export const MAX_SHOWN_IMAGES = 9

export type RecentImagesCheckResult =
  | { status: 'none' } // 没有新图片（或非 App 端）
  | { status: 'denied' } // 相册读取权限被拒绝
  | { status: 'ok'; items: RecentImageData[] }

/** 同一次 App 会话内已确认权限被拒：不再反复弹系统授权框 */
let permissionDeniedOnce = false

/**
 * 读取相册里最近新增的图片（截图 + 相机照片 + 其它，仅 App 端生效）。
 * - Web / 思源插件 / 无插件环境返回 { status: 'none' }，不影响其它端；
 * - 权限被拒返回 { status: 'denied' }；
 * - 相册里没有“新鲜”图片返回 { status: 'none' }。
 */
export async function readRecentImages(): Promise<RecentImagesCheckResult> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return { status: 'none' }
  }
  if (permissionDeniedOnce) return { status: 'denied' }
  try {
    const res = await RecentImages.listRecentImages({
      maxAgeSeconds: IMAGE_MAX_AGE_SECONDS,
      limit: 12,
    })
    if (res?.permissionDenied) {
      permissionDeniedOnce = true
      return { status: 'denied' }
    }
    const items = (res?.items ?? []).filter(
      (it) => it.base64 && it.mime?.startsWith('image/') && it.size > 0,
    )
    if (!items.length) return { status: 'none' }
    return { status: 'ok', items }
  } catch {
    return { status: 'none' }
  }
}

/** 图片指纹（新增时间:大小）：用于与已有附件去重、避免重复添加 */
export function imageFingerprint(it: { dateAdded: number; size: number }): string {
  return `${it.dateAdded}:${it.size}`
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

/** 由 MIME 生成附件文件名（带时间戳，避免同名覆盖） */
export function imageFileName(mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'png'
  const ts = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
  return `新图片_${stamp}.${ext}`
}

/** base64 → File（供现有附件上传队列直接使用） */
export function base64ToFile(data: { mime: string; base64: string }, name: string): File {
  const bin = atob(data.base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: data.mime })
}
