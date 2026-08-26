import JSZip from 'jszip'
import type OSS from 'ali-oss'
import { createOssClient } from './oss'
import { decoder } from './crypto'
import { decryptDay, decryptFileBytes, encryptDay, encryptFileBytes, type DiaryMeta } from './diaryCrypto'
import { cacheDiaryBlobUrl, getCachedDiaryBlobUrl } from './diaryBlobCache'
import type { DiaryDay } from '@/types'

/** 隐私日记存储层：所有读写均为密文。独立命名空间 users/{username}/diary/ */

const pad2 = (n: number) => String(n).padStart(2, '0')

export function diaryDayKey(username: string, y: string, m: string, d: string): string {
  return `users/${username}/diary/${y}/${pad2(Number(m))}/${pad2(Number(d))}.json`
}

/** 把 key 形如 users/{username}/diary/YYYY/MM/DD.json 解析成日期键 YYYY-MM-DD；无法解析返回 null */
function dateKeyFromKey(username: string, key: string): string | null {
  const prefix = `users/${username}/diary/`
  if (!key.startsWith(prefix)) return null
  const rel = key.slice(prefix.length)
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\.json$/.exec(rel)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** 分页列出某前缀下全部对象 key */
export async function listAllKeys(client: OSS, prefix: string): Promise<string[]> {
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
export async function getDiaryMeta(client: OSS, username: string): Promise<DiaryMeta | null> {
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

export async function putDiaryMeta(client: OSS, username: string, meta: DiaryMeta): Promise<void> {
  await client.put(`users/${username}/diary/_meta.json`, new Blob([JSON.stringify(meta)], { type: 'application/json' }))
}

/** 列出某月（YYYY-MM）存在日记的日期键列表（仅取 key，不解密内容） */
export async function listDiaryMonthDays(
  client: OSS,
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

/** 加载并解密某天日记；无记录返回 null */
export async function loadDiaryDay(
  client: OSS,
  username: string,
  dek: Uint8Array,
  dateKey: string,
): Promise<DiaryDay | null> {
  const [y, m, d] = dateKey.split('-')
  try {
    const res = await client.get(diaryDayKey(username, y, m, d))
    if (res.res.status === 404) return null
    const cipher = res.content.toString()
    const plain = await decryptDay(dek, cipher)
    const day = JSON.parse(plain) as DiaryDay
    if (!day.messages) day.messages = []
    return day
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') return null
    throw e
  }
}

/** 加密并写入某天日记（整体密文） */
export async function saveDiaryDay(
  client: OSS,
  username: string,
  dek: Uint8Array,
  dateKey: string,
  day: DiaryDay,
): Promise<void> {
  const [y, m, d] = dateKey.split('-')
  const cipher = await encryptDay(dek, JSON.stringify(day))
  // ali-oss 浏览器版 put 只接受 Buffer/Blob/File，不能传纯字符串
  await client.put(
    diaryDayKey(username, y, m, d),
    new Blob([cipher], { type: 'application/json' }),
  )
}

/** 删除某天日记文件（空日记清理用） */
export async function deleteDiaryDay(client: OSS, username: string, dateKey: string): Promise<void> {
  const [y, m, d] = dateKey.split('-')
  try {
    await client.delete(diaryDayKey(username, y, m, d))
  } catch {
    /* 删除失败不影响业务 */
  }
}

/** 上传附件/音频密文 */
export async function uploadDiaryFile(
  client: OSS,
  username: string,
  dek: Uint8Array,
  fileId: string,
  data: Uint8Array,
): Promise<void> {
  const cipher = await encryptFileBytes(dek, data)
  await client.put(
    `users/${username}/diary/files/${fileId}`,
    new Blob([cipher as unknown as BlobPart], { type: 'application/octet-stream' }),
  )
}

/** 下载并解密附件/音频字节 */
export async function downloadDiaryFileBytes(
  client: OSS,
  username: string,
  dek: Uint8Array,
  fileId: string,
): Promise<Uint8Array> {
  const res = await client.get(`users/${username}/diary/files/${fileId}`)
  const bytes = new Uint8Array(await new Blob([res.content as unknown as BlobPart]).arrayBuffer())
  return decryptFileBytes(dek, bytes)
}

export async function deleteDiaryFile(client: OSS, username: string, fileId: string): Promise<void> {
  try {
    await client.delete(`users/${username}/diary/files/${fileId}`)
  } catch {
    /* 忽略 */
  }
}

/** ---- 解密文件的可预览 Blob URL 缓存（内存态，退出系统时统一释放） ---- */
export async function getDiaryFileUrl(
  client: OSS,
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
 *  保证导入后图片/语音等可正常展示。 */
export async function exportDiary(
  client: OSS,
  username: string,
  dek: Uint8Array,
  y: string,
  m?: string,
): Promise<{ blob: Blob; name: string; count: number }> {
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
    // 收集该日引用的附件 fileId（仅日文件需要解析；单日失败不阻断导出）
    if (rel.endsWith('.json')) {
      try {
        const plain = await decryptDay(dek, decoder.decode(bytes))
        const day = JSON.parse(plain) as DiaryDay
        for (const msg of day.messages ?? []) {
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
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const name = m
    ? `diary-export-${y}-${pad2(Number(m))}.zip`
    : `diary-export-${y}.zip`
  return { blob, name, count }
}

/** 导入条目名称白名单：仅接受 YYYY/MM/DD.json 与 files/{uuid}，拒绝 _meta.json 及任何可逃逸路径 */
function isSafeImportEntry(name: string): boolean {
  const day = /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\.json$/.exec(name)
  if (day) return true
  const file = /^files\/[0-9a-fA-F-]{1,64}$/.exec(name)
  if (file) return true
  return false
}

/** 导入：解包 zip → 名称白名单校验 + 用当前 DEK 解密验证 → 通过后逐条合并写回（未导入的月/日保持不变） */
export async function importDiary(
  client: OSS,
  username: string,
  dek: Uint8Array,
  file: File,
): Promise<number> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  if (!entries.length) throw new Error('压缩包为空或格式不正确')

  // 校验阶段：全部通过才写入，避免半途失败；非法路径（../ 等）直接拒绝
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/').replace(/^\.\//, '')
    if (name === '_meta.json') continue
    if (!isSafeImportEntry(name)) throw new Error('压缩包包含不合法路径，已拒绝导入')
    const bytes = new Uint8Array(await entry.async('uint8array'))
    if (name.endsWith('.json')) {
      await decryptDay(dek, decoder.decode(bytes))
    } else {
      await decryptFileBytes(dek, bytes)
    }
  }

  // 写入阶段：逐条合并（同 key 覆盖，未涉及的不动）
  let imported = 0
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/').replace(/^\.\//, '')
    if (name === '_meta.json') continue
    const bytes = new Uint8Array(await entry.async('uint8array'))
    await client.put(
      `users/${username}/diary/${name}`,
      new Blob([bytes as unknown as BlobPart], { type: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' }),
    )
    imported++
  }
  return imported
}

