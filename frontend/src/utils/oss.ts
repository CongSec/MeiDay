import { AwsClient } from 'aws4fetch'
import type { CredFields } from '@/types'

/**
 * 对象存储客户端：阿里云 OSS / 腾讯云 COS / 华为云 OBS / 七牛 Kodo / MinIO / R2
 * 等所有「S3 兼容」服务。返回的客户端只暴露 get/put/delete/list
 * 四个方法与原 ali-oss 完全一致的调用约定，所有调用点无需改动。
 *
 * 对用户无感、无需选择厂商：只要把存储桶地址（endpoint）填成对应厂商的
 * S3 兼容域名即可，Region 由域名自动推断。
 *
 * 访问样式自动选择：
 *  - 公网厂商域名（阿里云/腾讯云/华为云/七牛/AWS/R2 等）用 Virtual-Hosted Style
 *    （https://bucket.endpoint/...）。阿里云 OSS 等厂商对 Path-Style（endpoint/bucket）
 *    会直接拒绝（SecondLevelDomainForbidden），必须用桶名作子域名。
 *  - endpoint 是 IP / localhost / 内网域名（.local/.internal），或 bucket 名含点号时
 *    回退 Path-Style（覆盖 MinIO 自建等无通配符 DNS 的场景）。
 */
export interface OssClient {
  get(
    key: string,
    options?: { headers?: Record<string, string> },
  ): Promise<{ content: OssContent; res: { status: number; headers: Record<string, string> } }>
  put(
    key: string,
    body: Blob | File | string,
    options?: { headers?: Record<string, string> },
  ): Promise<{ res: { status: number; headers: Record<string, string> } }>
  delete(key: string): Promise<void>
  list(
    query: Record<string, string | number | undefined>,
    options?: Record<string, unknown>,
  ): Promise<{
    objects: { name: string; lastModified?: string }[]
    isTruncated: boolean
    nextMarker?: string
  }>
}

/**
 * 读取到的对象内容：底层是字节数组（二进制附件可直接 new Blob([content])），
 * 同时给实例挂一个 UTF-8 解码的 toString()，保证 JSON 文本调用与 ali-oss 一致。
 */
export type OssContent = Uint8Array & { toString(): string }

function textContent(bytes: Uint8Array): OssContent {
  const arr = bytes as OssContent
  arr.toString = () => new TextDecoder().decode(bytes)
  return arr
}

/** 规范化 endpoint：补全协议、去掉末尾斜杠；兼容用户误填完整域名 */
function normalizeEndpoint(endpoint: string): string {
  let ep = (endpoint || '').trim()
  if (!ep) return ep
  if (!/^https?:\/\//i.test(ep)) ep = 'https://' + ep
  return ep.replace(/\/+$/, '')
}

/**
 * 从 endpoint 域名推断 S3 签名用的 Region：
 * - 腾讯云 COS / 华为云 OBS / 七牛 Kodo / 阿里云 OSS S3 兼容域名自带 region，直接提取；
 * - Cloudflare R2 固定为 auto；
 * - MinIO / 自建 / 自定义域名等不校验 region 的服务回退 us-east-1（签名时保持一致即可）。
 */
function guessRegion(endpoint: string): string {
  try {
    const host = new URL(normalizeEndpoint(endpoint)).hostname.toLowerCase()
    let m = /^cos\.([^.]+)\.myqcloud\.com$/i.exec(host)
    if (m) return m[1]
    m = /^obs\.([^.]+)\.myhuaweicloud\.com$/i.exec(host)
    if (m) return m[1]
    m = /^s3-([^.]+)\.qiniucs\.com$/i.exec(host)
    if (m) return m[1]
    m = /^oss-([^.]+)\.aliyuncs\.com$/i.exec(host)
    if (m) return m[1]
    if (host.endsWith('.r2.cloudflarestorage.com')) return 'auto'
  } catch {
    /* 非法 URL 交给下游报错 */
  }
  return 'us-east-1'
}

/** 对 key 逐段 URL 编码，保留路径分隔符 */
function encKey(key: string): string {
  return key
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/** S3 错误响应体是 XML：解析出 code/message/requestId 便于用户定位 */
async function toS3Error(res: Response, key: string): Promise<Error & { status: number; code?: string; message?: string; requestId?: string }> {
  let code = ''
  let message = ''
  let requestId = ''
  try {
    const xml = await res.text()
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    code = doc.getElementsByTagName('Code')[0]?.textContent ?? ''
    message = doc.getElementsByTagName('Message')[0]?.textContent ?? ''
    requestId = doc.getElementsByTagName('RequestId')[0]?.textContent ?? ''
  } catch {
    /* 非 XML 响应（如 CORS 拦截时读不到 body）忽略 */
  }
  const fallback = message || `OSS 请求失败（HTTP ${res.status}${key ? '：' + key : ''}）`
  const err = new Error(fallback) as Error & { status: number; code?: string; requestId?: string }
  err.status = res.status
  if (code) err.code = code
  if (requestId) err.requestId = requestId
  return err
}

function headersToObj(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = v
  })
  return out
}

/** 解析 S3 ListObjects（V1）返回的 XML，转成 ali-oss list 的返回结构 */
function parseListBucketResult(xml: string): {
  objects: { name: string; lastModified?: string }[]
  isTruncated: boolean
  nextMarker?: string
} {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const contents = Array.from(doc.getElementsByTagName('Contents'))
  const objects = contents.map((c) => ({
    name: c.getElementsByTagName('Key')[0]?.textContent ?? '',
    lastModified: c.getElementsByTagName('LastModified')[0]?.textContent ?? undefined,
  }))
  const isTruncated = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true'
  let nextMarker = doc.getElementsByTagName('NextMarker')[0]?.textContent ?? undefined
  // 部分实现截断时未回填 NextMarker：按 S3 规范用最后一个 key 作 marker 翻页
  if (isTruncated && !nextMarker && objects.length) nextMarker = objects[objects.length - 1].name
  return { objects, isTruncated, nextMarker }
}

/** 公有云厂商（桶名作子域名）的 S3 域名后缀。
 *
 * 只有这些厂商提供 bucket.<endpoint> 的泛域名解析（Virtual-Hosted Style）；
 * MinIO / 自建 / 自定义域名通常没有通配符 DNS，必须用 Path-Style（endpoint/bucket）。 */
const VENDOR_HOST_RE =
  /(aliyuncs\.com|myqcloud\.com|myhuaweicloud\.com|qiniucs\.com|amazonaws\.com|r2\.cloudflarestorage\.com)$/i

/**
 * 解析访问基础 URL：公网厂商域名走 Virtual-Hosted Style（https://bucket.endpoint）；
 * endpoint 是 IP / localhost / 内网域名，或 bucket 名含点号，或非厂商自定义域名
 * （MinIO 自建等）时回退 Path-Style（endpoint/bucket）。
 */
function resolveBase(endpoint: string, bucket: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return `${endpoint}/${encodeURIComponent(bucket)}`
  }
  const host = parsed.hostname.toLowerCase()
  const isIp =
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    (host.includes(':') && /^[0-9a-f:]+$/.test(host))
  const isLocal = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')
  const isVendor = VENDOR_HOST_RE.test(host)
  const pathStyle = isIp || isLocal || bucket.includes('.') || !isVendor
  if (pathStyle) return `${endpoint}/${encodeURIComponent(bucket)}`
  return `${parsed.protocol}//${encodeURIComponent(bucket)}.${parsed.host}`
}

/** 创建 S3 兼容对象存储客户端（异步：内部用轻量 aws4fetch 做 SigV4 签名） */
export async function createOssClient(creds: CredFields): Promise<OssClient> {
  const endpoint = normalizeEndpoint(creds.endpoint)
  const region = guessRegion(endpoint)
  const aws = new AwsClient({
    accessKeyId: creds.ossAk,
    secretAccessKey: creds.ossSk,
    service: 's3',
    region,
    retries: 3,
  })
  const base = resolveBase(endpoint, creds.bucket)

  return {
    async get(key, options) {
      const url = `${base}/${encKey(key)}`
      const res = await aws.fetch(url, {
        method: 'GET',
        headers: options?.headers,
      })
      if (res.status === 304) {
        return { content: textContent(new Uint8Array(0)), res: { status: 304, headers: headersToObj(res.headers) } }
      }
      if (!res.ok) throw await toS3Error(res, key)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { content: textContent(bytes), res: { status: res.status, headers: headersToObj(res.headers) } }
    },

    async put(key, body, options) {
      const url = `${base}/${encKey(key)}`
      const blob = typeof body === 'string' ? new Blob([body]) : (body as Blob)
      const res = await aws.fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          ...(options?.headers ?? {}),
        },
        body: await blob.arrayBuffer(),
      })
      if (!res.ok) throw await toS3Error(res, key)
      return { res: { status: res.status, headers: headersToObj(res.headers) } }
    },

    async delete(key) {
      const url = `${base}/${encKey(key)}`
      const res = await aws.fetch(url, { method: 'DELETE' })
      // S3 DELETE 幂等：对象不存在也返回 204，不必抛错
      if (!res.ok && res.status !== 404) throw await toS3Error(res, key)
    },

    async list(query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
      }
      const url = `${base}?${params.toString()}`
      const res = await aws.fetch(url, { method: 'GET' })
      if (!res.ok) throw await toS3Error(res, '')
      return parseListBucketResult(await res.text())
    },
  }
}

interface OssErrorLike {
  code?: string | number
  status?: number
  name?: string
  message?: string
  requestId?: string
}

/** 把对象存储抛出的原始错误转成用户能看懂的中文提示（阿里云 OSS / 各 S3 兼容厂商通用） */
export function describeOssError(e: unknown): string {
  const err = (e ?? {}) as OssErrorLike
  const code = err.code
  const status = err.status
  const name = err.name
  const message = err.message
  const detail = [message, code, status].filter((v) => v !== undefined && v !== '').join(' / ')

  // 浏览器跨域 / 网络层失败：status 为 0 / -1，或 fetch 抛出的 TypeError / Failed to fetch
  const corsish =
    status === 0 ||
    status === -1 ||
    /xhr|typeerror/i.test(name ?? '') ||
    /XMLHttpRequest|Failed to fetch|NetworkError|network error|fetch failed|cross-origin|CORS|跨域|网络|Failed to execute/i.test(
      message ?? '',
    )
  if (corsish) {
    return 'OSS 请求被浏览器拦截或网络不可达，通常是 Bucket 未配置 CORS（网页版请允许 https://localhost:5173，Android APK 请允许 https://localhost），或本地网络/DNS 异常'
  }

  switch (code) {
    case 'InvalidAccessKeyId':
    case 'SecurityTokenExpired':
    case 'AccessKeyId':
      return `OSS AccessKey 无效或已过期，请检查 AK/SK（${detail}）`
    case 'SignatureDoesNotMatch':
    case 'AuthorizationHeaderMalformed':
    case 'RequestTimeTooSkewed':
      return `OSS 签名校验失败，通常是 SecretKey 错误、endpoint 填错或本机时间不准（${detail}）`
    case 'AccessDenied':
      return `OSS 访问被拒绝，请检查 Bucket 名称与访问策略是否覆盖本用户名路径（${detail}）`
    case 'NoSuchBucket':
      return `OSS Bucket 不存在，请检查 Bucket 名称及所在 Region（${detail}）`
    case 'NoSuchKey':
      return 'OSS 上还没有数据（首次使用属正常情况）'
    case 'NoSuchCORSConfiguration':
      return 'OSS Bucket 未配置 CORS，请在存储桶控制台为该 Bucket 开启 CORS'
    case 'BucketAlreadyExists':
      return 'OSS Bucket 名称已被占用，请更换名称'
    case 'SecondLevelDomainForbidden':
      return `OSS Bucket 访问样式被拒绝：该厂商要求虚拟主机样式（bucket.endpoint），请检查 endpoint 是否为厂商 S3 兼容域名（${detail}）`
  }

  if (status === 403) {
    return `OSS 访问被拒绝（HTTP 403），请检查 AK/SK、Bucket 名称与访问策略（${detail}）`
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
  /** 隐私日记命名空间（独立于任务数据）：所有对象均为密文 */
  diary: (username: string) => `users/${username}/diary/`,
  diaryMeta: (username: string) => `users/${username}/diary/_meta.json`,
  /** 附件密文：diary/files/{fileId} */
  diaryFile: (username: string, fileId: string) =>
    `users/${username}/diary/files/${fileId}`,
  /** 附件二进制（明文直传）存放路径：taskId 为主任务 id，fileId 为附件 id */
  attachment: (username: string, taskId: string, fileId: string) =>
    `users/${username}/attachments/${taskId}/${fileId}`,
}
