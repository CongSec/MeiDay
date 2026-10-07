import { idbDel, idbGet, idbListKeys, idbPut } from './idb'
import { downloadAttachment } from './attachments'
import type { AttachmentMeta, CredFields } from '@/types'

/**
 * 资源视图图片缩略图：懒加载 + IndexedDB 缓存 + canvas 降采样。
 *
 * 背景：用户 OSS 是 S3 兼容存储，无服务端裁剪；缩略图只能下载原图后在浏览器本地降采样。
 * 为控制成本：
 *  - 仅对「位图类型 + 大小 ≤ 2MB」的附件生成缩略图（大图只显示占位图标，点击仍可预览/下载）；
 *  - 下载 + 降采样并发受限（最多 4 个在途），同 key 并发请求去重；
 *  - 结果以 dataURL 字符串缓存进 IDB（kv 仓，按用户名命名空间），超上限按「最久未用」逐出。
 */

/** 缩略图最长边（px） */
const THUMB_MAX_SIDE = 320
/** 降采样输出质量（webp） */
const THUMB_QUALITY = 0.8
/** 每用户缩略图缓存上限（条）；超出按最久未用逐出 */
const THUMB_MAX_ENTRIES = 400
/** 超过该大小的图片不生成缩略图（避免下载大图成本；点击仍可预览/下载） */
const THUMB_DOWNLOAD_LIMIT = 2 * 1024 * 1024
/** 下载 + 降采样并发上限 */
const THUMB_CONCURRENCY = 4

/** 安全的位图 MIME（与 attachments.ts 的 SAFE_IMAGE_TYPES 对应，不含 SVG 等可脚本格式） */
const THUMB_IMAGE_RE = /^image\/(png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)$/i

interface ThumbCacheEntry {
  /** 最近使用时间戳（epoch ms），用于逐出 */
  t: number
  /** 降采样后的 dataURL */
  u: string
}

function cacheKey(username: string, key: string, size: number): string {
  return `thumb:${username}:${key}:${size}`
}

const inflight = new Map<string, Promise<string | null>>()

let active = 0
const waiters: (() => void)[] = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= THUMB_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    waiters.shift()?.()
  }
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}

/** canvas 降采样为 webp dataURL（失败返回 null） */
async function downscaleToDataUrl(blob: Blob): Promise<string | null> {
  try {
    const img = await loadImage(blob)
    const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/webp', THUMB_QUALITY)
  } catch {
    return null
  }
}

/** 写入缩略图缓存；超出上限按「最久未用」逐出（缩略图可重建，逐出任意条目即可） */
async function putThumb(cacheKeyStr: string, dataUrl: string, username: string): Promise<void> {
  await idbPut('kv', cacheKeyStr, { t: Date.now(), u: dataUrl } satisfies ThumbCacheEntry)
  const prefix = `thumb:${username}:`
  const keys = await idbListKeys('kv', prefix)
  if (keys.length <= THUMB_MAX_ENTRIES) return
  const entries = await Promise.all(
    keys.map(async (k) => ({ k, e: await idbGet<ThumbCacheEntry>('kv', k) })),
  )
  const sortable = entries.filter((x): x is { k: string; e: ThumbCacheEntry } => !!x?.e)
  sortable.sort((a, b) => a.e.t - b.e.t)
  const excess = sortable.length - THUMB_MAX_ENTRIES
  for (let i = 0; i < excess && i < sortable.length; i++) {
    await idbDel('kv', sortable[i].k)
  }
}

/**
 * 获取附件缩略图（dataURL）。非安全位图 / 超大图片返回 null；网络或解码失败返回 null。
 * 同一 key 并发请求共享同一次下载；结果缓存进 IDB（键含 size，文件变化后自动失效）。
 */
export async function getThumbnailUrl(
  username: string,
  creds: CredFields,
  item: { key: string; name: string; size: number; type: string },
): Promise<string | null> {
  if (!THUMB_IMAGE_RE.test(item.type || '')) return null
  if (!item.size || item.size > THUMB_DOWNLOAD_LIMIT) return null
  const ck = cacheKey(username, item.key, item.size)
  const cached = await idbGet<ThumbCacheEntry>('kv', ck)
  if (cached?.u) {
    // 命中缓存：异步刷新最近使用时间（不阻塞返回）
    void idbPut('kv', ck, { t: Date.now(), u: cached.u } satisfies ThumbCacheEntry).catch(() => {})
    return cached.u
  }
  const existing = inflight.get(ck)
  if (existing) return existing
  const p = withSlot(async () => {
    const meta: AttachmentMeta = {
      id: '',
      name: item.name,
      size: item.size,
      type: item.type,
      key: item.key,
      uploadedAt: '',
    }
    const blob = await downloadAttachment(creds, meta)
    const dataUrl = await downscaleToDataUrl(blob)
    if (!dataUrl) return null
    await putThumb(ck, dataUrl, username)
    return dataUrl
  })
  inflight.set(ck, p)
  try {
    return await p
  } finally {
    inflight.delete(ck)
  }
}
