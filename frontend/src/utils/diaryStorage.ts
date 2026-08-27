import JSZip from 'jszip'
import type { OssClient } from '@/utils/oss'
import { createOssClient, describeOssError } from './oss'
import { decoder } from './crypto'
import {
  decryptDay, decryptFileBytes, encryptDay, encryptFileBytes, friendlyDecryptError,
  unwrapDiaryDekForExport, wrapDiaryDekForExport,
  type DiaryExportKey, type DiaryMeta,
} from './diaryCrypto'
import { cacheDiaryBlobUrl, getCachedDiaryBlobUrl } from './diaryBlobCache'
import { nowIso } from './time'
import type { DiaryBatch, DiaryMessage } from '@/types'

/** 隐私日记存储层：所有读写均为密文。独立命名空间 users/{username}/diary/ */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 导出 zip 内携带密钥的固定文件名（跨账号迁移用）：内容为「导出密码」包装的源 DEK */
export const EXPORT_DEK_ENTRY = 'dek.json'

/** 批次文件 key：users/{username}/diary/YYYY/MM/DD/{batchId}.json
 *  （每天一个文件夹，同一天内不同会话批次的写入互不覆盖） */
export function diaryBatchKey(username: string, y: string, m: string, d: string, batchId: string): string {
  return `users/${username}/diary/${y}/${pad2(Number(m))}/${pad2(Number(d))}/${batchId}.json`
}

/** 某天的日期文件夹前缀：users/{username}/diary/YYYY/MM/DD/ */
function diaryDayFolderPrefix(username: string, y: string, m: string, d: string): string {
  return `users/${username}/diary/${y}/${pad2(Number(m))}/${pad2(Number(d))}/`
}

/** 把 key 形如 users/{username}/diary/YYYY/MM/DD/{batchId}.json 解析成日期键 YYYY-MM-DD；无法解析返回 null */
function dateKeyFromKey(username: string, key: string): string | null {
  const prefix = `users/${username}/diary/`
  if (!key.startsWith(prefix)) return null
  const rel = key.slice(prefix.length)
  // 只认批次文件（YYYY/MM/DD/{batchId}.json）；旧版单文件 YYYY/MM/DD.json 与 files/、_meta.json 均不匹配
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\/[^/]+\.json$/.exec(rel)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** 从批次文件 key 中解析出 batchId；无法解析返回 null */
function batchIdFromKey(key: string): string | null {
  const m = /\/([^/]+)\.json$/.exec(key)
  return m ? m[1] : null
}

/** 分页列出某前缀下全部对象 key */
export async function listAllKeys(client: OssClient, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let marker: string | undefined
  do {
    const res = await client.list(
      {
        prefix,
        marker,
        'max-keys': 1000,
      },
      {},
    )
    for (const obj of res.objects ?? []) keys.push(obj.name)
    marker = res.isTruncated ? res.nextMarker : undefined
  } while (marker)
  return keys
}

/** 读取 _meta.json；不存在返回 null */
export async function getDiaryMeta(client: OssClient, username: string): Promise<DiaryMeta | null> {
  try {
    const res = await client.get(`users/${username}/diary/_meta.json`)
    if (res.res.status === 404) return null
    return JSON.parse(res.content.toString()) as DiaryMeta
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') return null
    throw e
  }
}

export async function putDiaryMeta(client: OssClient, username: string, meta: DiaryMeta): Promise<void> {
  await client.put(`users/${username}/diary/_meta.json`, new Blob([JSON.stringify(meta)], { type: 'application/json' }))
}

/** 列出某月（YYYY-MM）存在日记的日期键列表（仅取 key，不解密内容） */
export async function listDiaryMonthDays(
  client: OssClient,
  username: string,
  y: string,
  m: string,
): Promise<string[]> {
  const prefix = `users/${username}/diary/${y}/${pad2(Number(m))}/`
  const keys = await listAllKeys(client, prefix)
  const days: string[] = []
  for (const k of keys) {
    const dk = dateKeyFromKey(username, k)
    if (dk) days.push(dk)
  }
  return days
}

/** 读取某天某个批次文件并解密；不存在返回 null */
export async function loadDiaryBatch(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  dateKey: string,
  batchId: string,
): Promise<DiaryBatch | null> {
  const [y, m, d] = dateKey.split('-')
  try {
    const res = await client.get(diaryBatchKey(username, y, m, d, batchId))
    if (res.res.status === 404) return null
    const plain = await decryptDay(dek, res.content.toString())
    const batch = JSON.parse(plain) as DiaryBatch
    if (!batch.messages) batch.messages = []
    return batch
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') return null
    throw e
  }
}

/** 加密并写入某天的一个批次文件 */
export async function saveDiaryBatch(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  dateKey: string,
  batch: DiaryBatch,
): Promise<void> {
  const [y, m, d] = dateKey.split('-')
  const cipher = await encryptDay(dek, JSON.stringify(batch))
  // ali-oss 浏览器版 put 只接受 Buffer/Blob/File，不能传纯字符串
  await client.put(
    diaryBatchKey(username, y, m, d, batch.batchId),
    new Blob([cipher], { type: 'application/json' }),
  )
}

/** 删除某天的一个批次文件（空批次清理用） */
export async function deleteDiaryBatch(
  client: OssClient,
  username: string,
  dateKey: string,
  batchId: string,
): Promise<void> {
  const [y, m, d] = dateKey.split('-')
  try {
    await client.delete(diaryBatchKey(username, y, m, d, batchId))
  } catch {
    /* 删除失败不影响业务 */
  }
}

/** 列出某天的全部批次文件并解密（消息按 createdAt 排序），用于天级懒加载 */
export async function listDiaryDayBatches(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  dateKey: string,
): Promise<DiaryBatch[]> {
  const [y, m, d] = dateKey.split('-')
  const keys = await listAllKeys(client, diaryDayFolderPrefix(username, y, m, d))
  const out: DiaryBatch[] = []
  for (const k of keys) {
    const batchId = batchIdFromKey(k)
    if (!batchId) continue
    try {
      const res = await client.get(k)
      if (res.res.status === 404) continue
      const plain = await decryptDay(dek, res.content.toString())
      const batch = JSON.parse(plain) as DiaryBatch
      if (!batch.messages) batch.messages = []
      batch.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      out.push(batch)
    } catch (e) {
      const err = e as { code?: string | number; status?: number }
      if (err.status === 404 || err.code === 'NoSuchKey') continue
      throw e
    }
  }
  return out
}

/** 回顾：扫描 [startKey, endKey] 日期闭区间内全部批次文件并解密，
 *  按天分组、消息按 createdAt 排序（只读回顾视图用，不解密附件内容）。 */
export async function listDiaryPeriodMessages(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  startKey: string,
  endKey: string,
): Promise<{ dateKey: string; messages: DiaryMessage[] }[]> {
  const keys = await listAllKeys(client, `users/${username}/diary/`)
  const byDay = new Map<string, DiaryMessage[]>()
  for (const k of keys) {
    const dk = dateKeyFromKey(username, k)
    if (!dk || dk < startKey || dk > endKey) continue
    if (!batchIdFromKey(k)) continue
    try {
      const res = await client.get(k)
      if (res.res.status === 404) continue
      const plain = await decryptDay(dek, res.content.toString())
      const batch = JSON.parse(plain) as DiaryBatch
      const list = byDay.get(dk) ?? []
      for (const m of batch.messages ?? []) list.push(m)
      byDay.set(dk, list)
    } catch (e) {
      const err = e as { code?: string | number; status?: number }
      if (err.status === 404 || err.code === 'NoSuchKey') continue
      throw e
    }
  }
  const days = Array.from(byDay.entries())
    .map(([dateKey, messages]) => {
      messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      return { dateKey, messages }
    })
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
  return days
}

/** 上传附件/音频密文（onProgress：0~1 小数，仅上传阶段回调；加密阶段百分比为 null） */
export async function uploadDiaryFile(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  fileId: string,
  data: Uint8Array,
  onProgress?: (p: number) => void,
): Promise<void> {
  const cipher = await encryptFileBytes(dek, data)
  await client.put(
    `users/${username}/diary/files/${fileId}`,
    new Blob([cipher as unknown as BlobPart], { type: 'application/octet-stream' }),
    onProgress ? { progress: (p: number) => onProgress(p) } as unknown as Parameters<typeof client.put>[2] : undefined,
  )
}

/** 下载并解密附件/音频字节 */
export async function downloadDiaryFileBytes(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  fileId: string,
): Promise<Uint8Array> {
  const res = await client.get(`users/${username}/diary/files/${fileId}`)
  const bytes = new Uint8Array(await new Blob([res.content as unknown as BlobPart]).arrayBuffer())
  return decryptFileBytes(dek, bytes)
}

export async function deleteDiaryFile(client: OssClient, username: string, fileId: string): Promise<void> {
  try {
    await client.delete(`users/${username}/diary/files/${fileId}`)
  } catch {
    /* 忽略 */
  }
}

/** ---- 解密文件的可预览 Blob URL 缓存（内存态，退出系统时统一释放） ---- */
export async function getDiaryFileUrl(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  fileId: string,
  mime: string,
): Promise<string> {
  const cached = getCachedDiaryBlobUrl(fileId)
  if (cached) return cached
  const bytes = await downloadDiaryFileBytes(client, username, dek, fileId)
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime || 'application/octet-stream' }))
  cacheDiaryBlobUrl(fileId, url)
  return url
}

/** ---- 导入 / 导出（按月或按年，保留 OSS 原始目录结构，内容均为密文） ---- */

/** 导出：把所选周期内全部密文对象按相对结构打包成 zip（不含 _meta.json）。
 *  附件统一存于命名空间根 files/，导出时按该周期日记引用的 fileId 一并打包，
 *  保证导入后图片/语音等可正常展示。
 *  导出密码用于把源 DEK 包装成 zip 内的 dek.json —— 跨账号导入时用它解开源 DEK，
 *  与账号登录密码完全解耦，可放心把导出文件+导出密码交给对方。 */
export async function exportDiary(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  y: string,
  m: string | undefined,
  exportPassword: string,
): Promise<{ blob: Blob; name: string; count: number }> {
  if (!exportPassword || !exportPassword.trim()) throw new Error('请先设置导出密码')
  const prefix = `users/${username}/diary/${y}${m ? `/${pad2(Number(m))}` : ''}/`
  const keys = await listAllKeys(client, prefix)
  const zip = new JSZip()
  let count = 0
  const wantedFiles = new Set<string>()
  for (const key of keys) {
    const rel = key.slice(`users/${username}/diary/`.length)
    if (rel === '_meta.json') continue
    const res = await client.get(key)
    const bytes = new Uint8Array(await new Blob([res.content as unknown as BlobPart]).arrayBuffer())
    zip.file(rel, bytes as unknown as Blob)
    count++
    // 收集该批次引用的附件 fileId（仅批次文件需要解析；单个失败不阻断导出）
    if (rel.endsWith('.json')) {
      try {
        const plain = await decryptDay(dek, decoder.decode(bytes))
        const batch = JSON.parse(plain) as DiaryBatch
        for (const msg of batch.messages ?? []) {
          if (msg.file?.fileId) wantedFiles.add(msg.file.fileId)
        }
      } catch {
        /* ignore */
      }
    }
  }
  // 把引用的附件一并打包
  if (wantedFiles.size) {
    const fileKeys = await listAllKeys(client, `users/${username}/diary/files/`)
    for (const key of fileKeys) {
      const fileId = key.slice(`users/${username}/diary/files/`.length)
      if (!wantedFiles.has(fileId)) continue
      const res = await client.get(key)
      const bytes = new Uint8Array(await new Blob([res.content as unknown as BlobPart]).arrayBuffer())
      zip.file(`files/${fileId}`, bytes as unknown as Blob)
      count++
    }
  }
  if (!count) throw new Error('该时间段内没有日记数据')
  // 用导出密码包装源 DEK 写入 dek.json（跨账号导入解锁用）
  zip.file(EXPORT_DEK_ENTRY, JSON.stringify(await wrapDiaryDekForExport(exportPassword, dek)))
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const name = m
    ? `diary-export-${y}-${pad2(Number(m))}.zip`
    : `diary-export-${y}.zip`
  return { blob, name, count }
}

/** 轻量检查 zip 是否携带跨账号密钥文件 dek.json（不校验内容、不解密，用于决定是否弹「导出密码」输入框） */
export async function peekDiaryZipHasDek(file: File): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    return Object.values(zip.files).some((f) => !f.dir && normalizeEntryName(f.name) === EXPORT_DEK_ENTRY)
  } catch {
    return false
  }
}

/** 把任意异常翻译成用户可读的中文提示：OSS 错误走 describeOssError，其余优先取 message */
export function describeDiaryError(e: unknown, fallback: string): string {
  const raw = (e ?? {}) as { code?: unknown; status?: unknown; message?: unknown; name?: unknown }
  const hasOssMarkers =
    (typeof raw.code === 'string' && raw.code !== '') || (typeof raw.status === 'number' && raw.status > 0)
  if (hasOssMarkers) return describeOssError(e)
  if (e instanceof Error) {
    const msg = (e.message ?? '').trim()
    if (msg) return msg
    if (typeof raw.name === 'string' && /DOMException/i.test(raw.name)) return '解密失败：日记密码不匹配或数据已损坏'
    return fallback
  }
  return fallback
}

/** 导入条目名称白名单：仅接受 YYYY/MM/DD/{batchId}.json、files/{uuid} 与根目录的 dek.json，
 *  拒绝 _meta.json 及任何可逃逸路径 */
function isSafeImportEntry(name: string): boolean {
  if (name === EXPORT_DEK_ENTRY) return true
  const batch = /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/[^/]+\.json$/.exec(name)
  if (batch) return true
  const file = /^files\/[0-9a-fA-F-]{1,64}$/.exec(name)
  if (file) return true
  return false
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 用给定 DEK 全量校验 zip 内所有条目均可解密（跳过 dek.json）；任一失败抛错 */
async function validateImportEntries(entries: JSZip.JSZipObject[], dek: Uint8Array): Promise<void> {
  for (const entry of entries) {
    const name = normalizeEntryName(entry.name)
    if (name === EXPORT_DEK_ENTRY) continue
    const bytes = new Uint8Array(await entry.async('uint8array'))
    if (name.endsWith('.json')) {
      await decryptDay(dek, decoder.decode(bytes))
    } else {
      await decryptFileBytes(dek, bytes)
    }
  }
}

/** 导入：
 *  - 若 zip 含 dek.json：先尝试用当前 DEK（同账号导出）解密；失败则视为跨账号，
 *    需提供导出密码解开源 DEK，再重加密成当前 DEK 写回；
 *  - 若 zip 无 dek.json：老版同账号导出，直接用当前 DEK。
 *  全部校验通过才写入，避免半途失败；非法路径（../ 等）直接拒绝。 */
export async function importDiary(
  client: OssClient,
  username: string,
  currentDek: Uint8Array,
  file: File,
  exportPassword?: string,
): Promise<number> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  if (!entries.length) throw new Error('压缩包为空或格式不正确')

  const dekEntry = entries.find((f) => normalizeEntryName(f.name) === EXPORT_DEK_ENTRY)

  // 路径白名单校验（dek.json 单独放行；_meta.json 与逃逸路径一律拒绝）
  for (const entry of entries) {
    const name = normalizeEntryName(entry.name)
    if (name === EXPORT_DEK_ENTRY) continue
    if (!isSafeImportEntry(name)) throw new Error('压缩包包含不合法路径，已拒绝导入')
  }

  // 确定解密用 DEK：同账号 → 当前 DEK；跨账号 → 用导出密码解开源 DEK
  let sourceDek = currentDek
  let crossAccount = false
  try {
    await validateImportEntries(entries, currentDek)
  } catch {
    if (!dekEntry) throw friendlyDecryptError()
    if (!exportPassword) {
      throw new Error('该压缩包来自其它账号，请输入导出时的日记密码后才能导入')
    }
    const payload = JSON.parse(await dekEntry.async('string')) as DiaryExportKey
    if (payload.v !== 1 || !payload.salt || !payload.iv || !payload.wrapped) {
      throw new Error('导出包中的密钥文件格式不正确，已拒绝导入')
    }
    const unlocked = await unwrapDiaryDekForExport(payload, exportPassword)
    if (!unlocked) throw new Error('导出密码错误，无法解开日记数据')
    // 用源 DEK 复核一遍，确认整包都能完整解密
    await validateImportEntries(entries, unlocked)
    sourceDek = unlocked
    crossAccount = true
  }

  // 写入阶段：逐条合并（未导入的批次保持不动）。
  // 批次文件：读取云端同批次 → 按消息 id 去重合并（zip 中消息优先）→ 加密写回，避免整体覆盖导致新消息丢失；
  // 附件：云端已存在则跳过，不存在才写入（跨账号时先用源 DEK 解密再重加密成当前 DEK）。
  let imported = 0
  for (const entry of entries) {
    const name = normalizeEntryName(entry.name)
    if (name === EXPORT_DEK_ENTRY) continue
    const bytes = new Uint8Array(await entry.async('uint8array'))
    if (name.endsWith('.json')) {
      const m = /^(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\.json$/.exec(name)
      if (!m) continue
      const dateKey = `${m[1]}-${m[2]}-${m[3]}`
      const batchId = m[4]
      const importedPlain = await decryptDay(sourceDek, decoder.decode(bytes))
      const importedBatch = JSON.parse(importedPlain) as DiaryBatch
      const importedMsgs = importedBatch.messages ?? []
      // 云端现有同批次（可能包含导入 zip 之后新增的消息；始终用当前 DEK 读）
      const existing = await loadDiaryBatch(client, username, currentDek, dateKey, batchId)
      const byId = new Map<string, DiaryMessage>()
      for (const msg of existing?.messages ?? []) byId.set(msg.id, msg)
      for (const msg of importedMsgs) byId.set(msg.id, msg)
      const merged: DiaryBatch = {
        v: 1,
        batchId,
        messages: Array.from(byId.values()),
        createdAt: existing?.createdAt ?? importedBatch.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await saveDiaryBatch(client, username, currentDek, dateKey, merged)
      imported++
    } else {
      const fullKey = `users/${username}/diary/${name}`
      const exists = await client
        .get(fullKey)
        .then(() => true)
        .catch((e: unknown) => {
          const err = e as { code?: string | number; status?: number }
          if (err.status === 404 || err.code === 'NoSuchKey') return false
          throw e
        })
      if (!exists) {
        const payload = crossAccount
          ? await encryptFileBytes(currentDek, await decryptFileBytes(sourceDek, bytes))
          : bytes
        await client.put(
          fullKey,
          new Blob([payload as unknown as BlobPart], { type: 'application/octet-stream' }),
        )
        imported++
      }
    }
  }
  return imported
}

/** 按月或按年删除日记（含引用的附件密文；未涉及月份保持不动）。
 *  每个附件 fileId 只被某一天的某条消息引用，故删除目标天的附件不会误伤其它天。 */
export async function deleteDiaryPeriod(
  client: OssClient,
  username: string,
  dek: Uint8Array,
  y: number,
  m?: number,
): Promise<{ days: number; files: number }> {
  const prefix = `users/${username}/diary/${y}${m !== undefined ? `/${pad2(Number(m))}` : ''}/`
  const keys = await listAllKeys(client, prefix)
  const batchKeys = keys.filter((k) => k.endsWith('.json'))
  const fileIds = new Set<string>()
  const daySet = new Set<string>()
  for (const k of batchKeys) {
    try {
      const res = await client.get(k)
      const bytes = new Uint8Array(await new Blob([res.content as unknown as BlobPart]).arrayBuffer())
      const plain = await decryptDay(dek, decoder.decode(bytes))
      const batch = JSON.parse(plain) as DiaryBatch
      for (const msg of batch.messages ?? []) {
        if (msg.file?.fileId) fileIds.add(msg.file.fileId)
      }
    } catch {
      /* 单个批次解密失败不阻断删除 */
    }
    const dk = dateKeyFromKey(username, k)
    if (dk) daySet.add(dk)
  }
  for (const k of batchKeys) {
    try {
      await client.delete(k)
    } catch {
      /* 忽略 */
    }
  }
  let files = 0
  for (const fid of fileIds) {
    try {
      await client.delete(`users/${username}/diary/files/${fid}`)
      files++
    } catch {
      /* 忽略 */
    }
  }
  return { days: daySet.size, files }
}
