import type OSS from 'ali-oss'
import type { CredFields } from '@/types'

/**
 * ali-oss SDK 体积较大（浏览器版约 690KB / gzip 约 188KB），静态 import 会拖慢首屏。
 * 这里改为【按需动态加载】：首次真正需要创建 OSS 客户端时才 import，之后缓存 Promise，
 * 避免每次调用都重新加载。登录页 / 首屏渲染因此完全不依赖该大 chunk。
 */
type AliOssNamespace = { default: typeof OSS }
let ossModulePromise: Promise<AliOssNamespace> | undefined

function loadOssModule(): Promise<AliOssNamespace> {
  if (!ossModulePromise) ossModulePromise = import('ali-oss')
  return ossModulePromise
}

/** 兼容用户误填完整 OSS 域名：自动去掉协议与 .aliyuncs.com 后缀，ali-oss SDK 只接受区域 ID */
function normalizeRegion(region: string): string {
  return (region || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\.aliyuncs\.com$/, '')
}

/** 创建 OSS 客户端（异步：首次调用会动态加载 ali-oss SDK） */
export async function createOssClient(creds: CredFields): Promise<OSS> {
  const OSSModule = await loadOssModule()
  const OSSClass = OSSModule.default
  return new OSSClass({
    region: normalizeRegion(creds.region),
    accessKeyId: creds.ossAk,
    accessKeySecret: creds.ossSk,
    bucket: creds.bucket,
    secure: true,
  })
}

interface OssErrorLike {
  code?: string | number
  status?: number
  name?: string
  message?: string
  requestId?: string
}

/** 把 ali-oss 抛出的原始错误转成用户能看懂的中文提示 */
export function describeOssError(e: unknown): string {
  const err = (e ?? {}) as OssErrorLike
  const code = err.code
  const status = err.status
  const name = err.name
  const message = err.message
  const detail = [message, code, status].filter((v) => v !== undefined && v !== '').join(' / ')

  // 浏览器跨域 / 网络层失败：status 为 0 / -1，或 ali-oss 抛出的 XMLHttpRequest 错误
  const corsish =
    status === 0 ||
    status === -1 ||
    /xhr/i.test(name ?? '') ||
    /XMLHttpRequest|Failed to fetch|NetworkError|network error|cross-origin|CORS|跨域|网络/i.test(
      message ?? '',
    )
  if (corsish) {
    return 'OSS 请求被浏览器拦截或网络不可达，通常是 Bucket 未配置 CORS（网页版请允许 https://localhost:5173，Android APK 请允许 https://localhost），或本地网络/DNS 异常'
  }

  switch (code) {
    case 'InvalidAccessKeyId':
    case 'SecurityTokenExpired':
      return `OSS AccessKey 无效或已过期，请检查 AK/SK（${detail}）`
    case 'SignatureDoesNotMatch':
      return `OSS 签名校验失败，通常是 SecretKey 错误或本机时间不准（${detail}）`
    case 'AccessDenied':
      return `OSS 访问被拒绝，请检查 Bucket 名称与 RAM 策略是否覆盖本用户名路径（${detail}）`
    case 'NoSuchBucket':
      return `OSS Bucket 不存在，请检查 Bucket 名称及所在 Region（${detail}）`
    case 'NoSuchKey':
      return 'OSS 上还没有数据（首次使用属正常情况）'
    case 'NoSuchCORSConfiguration':
      return 'OSS Bucket 未配置 CORS，请在阿里云控制台为该 Bucket 开启 CORS'
  }

  if (status === 403) {
    return `OSS 访问被拒绝（HTTP 403），请检查 AK/SK、Bucket 名称与 RAM 策略（${detail}）`
  }
  if (status && status >= 400 && status < 500) {
    return `OSS 请求失败（HTTP ${status}），请检查 OSS 配置（${code ?? message ?? '未知错误'}）`
  }
  if (status && status >= 500) {
    return `OSS 服务端异常（HTTP ${status}），请稍后重试（${detail}）`
  }
  if (detail) return `OSS 请求失败（${detail}）`
  return 'OSS 请求失败，请检查网络或 OSS 配置'
}

export const paths = {
  profile: (username: string) => `users/${username}/profile.json`,
  stats: (username: string) => `users/${username}/stats.json`,
  today: (username: string) => `users/${username}/today.json`,
  todayTrash: (username: string) => `users/${username}/today_trash.json`,
  todayRepeats: (username: string) => `users/${username}/today_repeats.json`,
  /** 今日任务跨项目拖拽顺序（独立于任务 JSON 的全局顺序表） */
  todayOrder: (username: string) => `users/${username}/today_order.json`,
  meta: (username: string, projectId: string) => `users/${username}/projects/${projectId}/meta.json`,
  tasks: (username: string, projectId: string) => `users/${username}/projects/${projectId}/tasks.json`,
  trash: (username: string, projectId: string) => `users/${username}/projects/${projectId}/trash.json`,
  repeats: (username: string, projectId: string) => `users/${username}/projects/${projectId}/repeats.json`,
  /** 附件二进制（明文直传）存放路径：taskId 为主任务 id，fileId 为附件 id */
  attachment: (username: string, taskId: string, fileId: string) =>
    `users/${username}/attachments/${taskId}/${fileId}`,
}
