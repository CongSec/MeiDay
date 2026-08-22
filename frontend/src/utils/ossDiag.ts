import { api, type OssCheckResult } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useUiStore, type OssErrorInfo } from '@/stores/ui'
import { describeOssError } from '@/utils/oss'
import type { CredFields } from '@/types'

/**
 * 根据后端诊断结果生成一个用户可读的中文提示。
 * 已知错误码映射为固定文案，其余情况亮出真实 code/status/message，方便用户直接核对。
 */
function hintFromDiag(diag: OssCheckResult): string {
  if (diag.ok) return 'OSS 连接正常'
  const code = String(diag.code ?? '')
  const detail = [
    diag.code ? `code=${diag.code}` : '',
    diag.status ? `HTTP ${diag.status}` : '',
    diag.message || '',
  ]
    .filter(Boolean)
    .join(' / ')
  switch (code) {
    case 'NoSuchBucket':
      return `OSS Bucket 不存在（可能已被删除或 Bucket 名称错误）。${detail}`
    case 'InvalidAccessKeyId':
    case 'SecurityTokenExpired':
      return `OSS AccessKey 无效或已过期。${detail}`
    case 'SignatureDoesNotMatch':
      return `OSS 签名校验失败，通常是 SecretKey 错误或本机时间不准。${detail}`
    case 'AccessDenied':
      return `OSS 访问被拒绝，请检查 RAM 策略是否授权本账号路径。${detail}`
    default:
      return `OSS 请求失败：${detail}`
  }
}

function baseInfo(creds: CredFields | null, fallback: string): OssErrorInfo {
  return {
    title: 'OSS 加载失败',
    hint: fallback,
    code: null,
    status: null,
    message: null,
    request_id: null,
    cors_configured: null,
    bucket: creds?.bucket ?? '',
    region: creds?.region ?? '',
  }
}

/** 前端 OSS 操作失败时调用：先展示兜底文案，再尝试用后端诊断补齐真实 code/message。 */
export async function enrichOssError(e: unknown, fallback = describeOssError(e)): Promise<string> {
  const auth = useAuthStore()
  const ui = useUiStore()
  const creds = auth.creds
  const rest = (e ?? {}) as { code?: string | number; status?: number; message?: string }
  const base = {
    ...baseInfo(creds, fallback),
    code: rest.code != null ? String(rest.code) : null,
    status: rest.status ?? null,
    message: rest.message ?? null,
  }
  if (!creds || !creds.ossAk || !creds.ossSk || !creds.bucket) {
    ui.showOssError(base)
    return fallback
  }
  try {
    const diag = await api.checkOss({
      oss_ak: creds.ossAk,
      oss_sk: creds.ossSk,
      bucket: creds.bucket,
      region: creds.region,
    })
    ui.showOssError({
      title: diag.ok ? 'OSS 连接恢复' : 'OSS 加载失败',
      hint: diag.ok ? fallback : hintFromDiag(diag),
      code: diag.code != null ? String(diag.code) : null,
      status: diag.status,
      message: diag.message,
      request_id: diag.request_id,
      cors_configured: diag.cors_configured,
      bucket: creds.bucket,
      region: creds.region,
    })
  } catch {
    ui.showOssError(base)
  }
  return fallback
}