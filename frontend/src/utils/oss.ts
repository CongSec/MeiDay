import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { AwsClient, AwsV4Signer } from 'aws4fetch'
import type { CredFields } from '@/types'
import { bytesToB64 } from './crypto'

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

/** 最小响应兼容层：原生 CapacitorHttp 的返回结构 + 浏览器 Response 共用的字段/方法 */
interface FetchLikeResponse {
  status: number
  ok: boolean
  headers: Headers
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

/** 原生 App（Android APK / iOS）环境判断：原生 HTTP 请求不经过 WebView 拦截器，无 CORS 限制 */
export function isNativeRuntime(): boolean {
  return typeof Capacitor !== 'undefined' && typeof Capacitor.isNativePlatform === 'function' && Capacitor.isNativePlatform()
}

/** 原生 HTTP 超时（毫秒）：连接与读取分开，避免弱网下无限期挂起 */
const NATIVE_CONNECT_TIMEOUT = 15_000
const NATIVE_READ_TIMEOUT = 30_000

/** 网络类失败重试次数与退避间隔（aws4fetch 只重试 5xx/429，网络错误一次就抛，这里补上） */
const NET_RETRIES = 3
const NET_BACKOFF_MS = [300, 900, 2000]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 大小写不敏感地从响应头里取值（原生端 header key 的大小写不固定） */
function getHeaderValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v != null) return String(v)
  }
  return undefined
}

/** CapacitorHttp 原生响应的 Response 兼容层：
 *  - 非 JSON 内容的 arraybuffer 响应在原生端是 base64 字符串，这里解码回字节；
 *  - content-type=json 时原生端已 parseJSON 成对象/数组或字符串，直接原样使用，不再二次解码。 */
class NativeResponse implements FetchLikeResponse {
  status: number
  headers: Headers
  private _bytes: Uint8Array | null
  private _text: string

  constructor(status: number, headerMap: Record<string, string>, data: unknown, decodeBase64: boolean) {
    this.status = status
    this.headers = new Headers()
    for (const [k, v] of Object.entries(headerMap ?? {})) {
      if (v != null) this.headers.set(k, String(v))
    }
    if (typeof data === 'string') {
      if (decodeBase64 && data.length > 0) {
        try {
          // Android 端 Base64.DEFAULT 每 76 字符插换行，解码前先去掉空白
          const cleaned = data.replace(/\s+/g, '')
          const bin = atob(cleaned)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          this._bytes = bytes
          this._text = new TextDecoder().decode(bytes)
          return
        } catch {
          /* 非 base64（理论不会出现）：回退按文本处理 */
        }
      }
      this._text = data
      this._bytes = null
    } else if (data != null) {
      // content-type=json 时原生端已解析成对象/数组；若 data 是字符串值
      // （如日记批次文件里的 base64 密文），会走上方 typeof data === 'string' 分支，
      // 且 decodeBase64=false，原样保留，避免二次解码损坏密文
      this._text = JSON.stringify(data)
      this._bytes = null
    } else {
      this._text = ''
      this._bytes = null
    }
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this._bytes) {
      return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength)
    }
    return new TextEncoder().encode(this._text).buffer as ArrayBuffer
  }

  async text(): Promise<string> {
    return this._text
  }
}

interface S3Init {
  method: string
  headers?: Record<string, string> | Headers
  body?: ArrayBuffer | string | null
}

/** 用 aws4fetch 的 AwsV4Signer 对请求做 SigV4 签名，返回可直接发送的 url/method/headers */
async function signS3(
  aws: AwsClient,
  url: string,
  init: S3Init,
): Promise<{ url: string; method: string; headers: Headers }> {
  const signer = new AwsV4Signer({
    url,
    method: init.method || 'GET',
    headers: init.headers instanceof Headers ? init.headers : new Headers(init.headers || {}),
    body: init.body ?? undefined,
    accessKeyId: aws.accessKeyId,
    secretAccessKey: aws.secretAccessKey,
    service: 's3',
    region: aws.region,
  })
  const signed = await signer.sign()
  return { url: signed.url.toString(), method: signed.method, headers: signed.headers }
}

/**
 * 原生端执行签名后的 OSS 请求：
 * - 直接走 CapacitorHttp 原生插件（GET 不再经过 WebView 拦截器，避免拦截器无超时/并发受限导致的偶发失败）；
 * - 显式设置连接/读取超时；
 * - 网络错误与 5xx/429 都会退避重试（aws4fetch 本身不重试网络错误）。
 *
 * 上传（PUT）body 处理 —— 修复手机端二进制上传损坏：
 * Android WebView 的 fetch 发送「二进制」ArrayBuffer body 会损坏非 UTF-8 字节
 * （ASCII 文本无损），导致手机端上传的图片/音频/附件在 OSS 上全部损坏、文本正常。
 * 因此原生端一律用 CapacitorHttp 原生 HTTP 发送，二进制体 base64 后经
 * dataType:'file' 交给原生解码回原始字节，字节完整且无 CORS 限制。
 *  - application/json 等文本体：直接原样传字符串（原生按 UTF-8 写入，字节无损）；
 *  - 其余任何类型（octet-stream / image/* 等）：base64 + dataType:'file' 原样还原。
 */
async function nativeS3Fetch(aws: AwsClient, url: string, init: S3Init): Promise<FetchLikeResponse> {
  const { url: finalUrl, method, headers } = await signS3(aws, url, init)
  const headerObj: Record<string, string> = {}
  headers.forEach((v, k) => {
    headerObj[k] = v
  })

  // 解析待发送的 body：文本原样传字符串；二进制 base64 + dataType:'file'
  let data: string | undefined
  let dataType: 'file' | undefined
  if (init.body != null) {
    const bodyBytes =
      init.body instanceof ArrayBuffer
        ? new Uint8Array(init.body)
        : typeof init.body === 'string'
          ? new TextEncoder().encode(init.body)
          : new Uint8Array(0)
    const contentType = getHeaderValue(headerObj, 'content-type') ?? ''
    if (/json|text|xml/i.test(contentType)) {
      data = new TextDecoder().decode(bodyBytes)
    } else {
      data = bytesToB64(bodyBytes)
      dataType = 'file'
    }
  }

  let lastErr: unknown = new Error('OSS 请求失败')
  for (let attempt = 0; attempt <= NET_RETRIES; attempt++) {
    try {
      const res = await CapacitorHttp.request({
        url: finalUrl,
        method,
        headers: headerObj,
        data,
        dataType,
        // 统一按二进制读取：成功体在原生端是 base64（解码回字节），错误体是文本
        responseType: 'arraybuffer',
        connectTimeout: NATIVE_CONNECT_TIMEOUT,
        readTimeout: NATIVE_READ_TIMEOUT,
      })
      // 5xx / 429 与网络错误一样可重试
      if (attempt >= NET_RETRIES || (res.status < 500 && res.status !== 429)) {
        // 原生端对 content-type=json 的响应总是先 parseJSON：对象/数组走 JSON.stringify 还原，
        // 字符串值（如日记批次文件里的 base64 密文）已是解析后的原文，不能再按 base64 二次解码，
        // 否则会把密文改写成乱码，导致「解密失败：日记密码不匹配或数据已损坏」（查看当天/回顾均受影响）
        const contentType = getHeaderValue(res.headers, 'content-type') ?? ''
        const isJson = /json/i.test(contentType)
        return new NativeResponse(res.status, res.headers, res.data, res.status < 400 && !isJson)
      }
      lastErr = new Error(`OSS 请求失败（HTTP ${res.status}）`)
    } catch (e) {
      lastErr = e
      if (attempt >= NET_RETRIES) throw e
    }
    await sleep(NET_BACKOFF_MS[attempt] ?? 2000)
  }
  throw lastErr
}

/** 统一的 S3 fetch：原生 App 走 CapacitorHttp（带超时/重试），Web/插件端走浏览器 fetch */
async function s3Fetch(aws: AwsClient, url: string, init: S3Init): Promise<FetchLikeResponse> {
  if (isNativeRuntime() && CapacitorHttp && typeof CapacitorHttp.request === 'function') {
    return nativeS3Fetch(aws, url, init)
  }
  return aws.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body ?? undefined,
  })
}

/** S3 错误响应体是 XML：解析出 code/message/requestId 便于用户定位 */
async function toS3Error(res: FetchLikeResponse, key: string): Promise<Error & { status: number; code?: string; message?: string; requestId?: string }> {
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
  // R2-304-CORS: Cloudflare R2 对条件 GET（If-Modified-Since/If-None-Match）命中时返回的 304
  // 响应不带 Access-Control-Allow-Origin 头，浏览器会拦截跨域读取；因此对 R2 剥离条件头、
  // 始终全量 GET（profile/stats/tasks 均为小文件，开销可忽略）。其它厂商（阿里云/七牛等）
  // 304 带 CORS 头，不受影响，仍走条件请求增量。
  let isR2 = false
  try {
    isR2 = /\.r2\.cloudflarestorage\.com$/i.test(new URL(endpoint).hostname)
  } catch {
    /* 非法 URL 交给下游报错 */
  }

  return {
    async get(key, options) {
      const url = `${base}/${encKey(key)}`
      let headers = options?.headers
      if (isR2 && headers) {
        // R2 的 304 响应无 CORS 头：条件请求命中时浏览器直接拦截，剥离条件头后始终全量 GET。
        const stripped: Record<string, string> = {}
        for (const [k, v] of Object.entries(headers)) {
          const lk = k.toLowerCase()
          if (lk === 'if-modified-since' || lk === 'if-none-match') continue
          stripped[k] = v
        }
        headers = stripped
      }
      const res = await s3Fetch(aws, url, {
        method: 'GET',
        headers,
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
      // 统一走 s3Fetch：原生端（Android/iOS）用 CapacitorHttp 原生 HTTP 上传，
      // 二进制 body 原样还原（见 nativeS3Fetch），Web 端仍用 aws.fetch。
      const res = await s3Fetch(aws, url, {
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
      const res = await s3Fetch(aws, url, { method: 'DELETE' })
      // S3 DELETE 幂等：对象不存在也返回 204，不必抛错
      if (!res.ok && res.status !== 404) throw await toS3Error(res, key)
    },

    async list(query) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
      }
      const url = `${base}?${params.toString()}`
      const res = await s3Fetch(aws, url, { method: 'GET' })
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

/** 原生 App 网络类异常码（CapacitorHttp 拒绝时 code = Java 异常类名） */
const NATIVE_NETWORK_CODE_RE =
  /unknownhost|connect|timeout|ssl|socket|eof|reset|refused|network|dns/i

/** 判断错误是否属于「网络层失败」（浏览器跨域 / DNS / 超时 / 连接失败等） */
export function isOssNetworkError(e: unknown): boolean {
  const err = (e ?? {}) as OssErrorLike
  const name = String(err.name ?? '')
  const message = String(err.message ?? '')
  const code = String(err.code ?? '')
  return (
    err.status === 0 ||
    err.status === -1 ||
    /xhr|typeerror/i.test(name) ||
    /XMLHttpRequest|Failed to fetch|NetworkError|network error|fetch failed|cross-origin|CORS|跨域|网络|Failed to execute/i.test(
      message,
    ) ||
    NATIVE_NETWORK_CODE_RE.test(code)
  )
}

/** 把对象存储抛出的原始错误转成用户能看懂的中文提示（阿里云 OSS / 各 S3 兼容厂商通用） */
export function describeOssError(e: unknown): string {
  const err = (e ?? {}) as OssErrorLike
  const code = err.code
  const status = err.status
  const name = err.name
  const message = err.message
  const detail = [message, code, status].filter((v) => v !== undefined && v !== '').join(' / ')

  // 原生 App：CapacitorHttp 拒绝时 code 是 Java 异常类名，映射成具体的网络问题
  if (isNativeRuntime() && code != null) {
    const c = String(code).toLowerCase()
    if (c.includes('unknownhost')) {
      return `OSS 域名解析失败（DNS 异常），请检查手机网络后重试${detail ? `（${detail}）` : ''}`
    }
    if (c.includes('timeout')) {
      return `连接 OSS 超时，请检查手机网络后重试${detail ? `（${detail}）` : ''}`
    }
    if (c.includes('connect') || c.includes('refused') || c.includes('network') || c.includes('route')) {
      return `无法连接 OSS 服务，请检查手机网络后重试${detail ? `（${detail}）` : ''}`
    }
    if (c.includes('ssl') || c.includes('handshake') || c.includes('certificate')) {
      return `与 OSS 建立 HTTPS 连接失败（证书校验/加密协商），请检查网络或稍后重试${detail ? `（${detail}）` : ''}`
    }
    if (c.includes('socket') || c.includes('reset') || c.includes('eof') || c.includes('broken')) {
      return `与 OSS 的连接被中断，请稍后重试${detail ? `（${detail}）` : ''}`
    }
  }

  // 浏览器跨域 / 网络层失败：status 为 0 / -1，或 fetch 抛出的 TypeError / Failed to fetch
  if (isOssNetworkError(e)) {
    if (isNativeRuntime()) {
      // 原生 HTTP 请求不经过浏览器，不存在 CORS 拦截；此处几乎都是网络/超时/DNS/TLS 问题
      return `无法连接 OSS 存储服务，请检查手机网络（能否访问外网、DNS 解析是否正常）${detail ? `。原始错误：${detail}` : ''}`
    }
    return 'OSS 请求被浏览器拦截或网络不可达，通常是 Bucket 未配置 CORS（请在存储桶控制台允许当前网页域名），或本地网络/DNS 异常'
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
  /** 回收站按月分片：trash/{YYYY-MM}.json（性能优化，日常只碰当月小文件；旧 trash.json 为迁移源） */
  trashShard: (username: string, projectId: string, month: string) => `users/${username}/projects/${projectId}/trash/${month}.json`,
  trashShardPrefix: (username: string, projectId: string) => `users/${username}/projects/${projectId}/trash/`,
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
