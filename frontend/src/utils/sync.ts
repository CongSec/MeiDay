import type { OssClient } from '@/utils/oss'
import type { DeletedProject, Profile, Project, StatsDailyEntry, StatsTaskDelta, Task, UserStats } from '@/types'

/**
 * 多端同步冲突处理：对 OSS 对象做“比较并交换”(Compare-And-Swap) 写入。
 *
 * 注意：阿里云 OSS 的 PutObject 并不支持 If-Match 条件头（实测会返回 400），
 * 因此这里的 CAS 采用「先 GET 远端 + ETag，比对 knownEtag 一致后才无条件 PUT」
 * 的读-写模式，避免所有写入请求 400 失败。
 */

type CasResult<T> =
  | { ok: true; etag: string }
  | { ok: false; reason: 'conflict'; remote: T | null; remoteEtag: string | null }

/** 大小写无关地读取响应头中的 ETag，并去掉常见的包围引号，保证读写比较稳定 */
function getEtag(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'etag') {
      const raw = String(headers[key] ?? '')
      return raw.replace(/^"|"$/g, '') || null
    }
  }
  return null
}

/** 大小写无关地读取 Content-MD5（base64），解码为 16 进制大写字符串 */
function getContentMd5Hex(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null
  let b64 = ''
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'content-md5') {
      b64 = String(headers[key] ?? '')
      break
    }
  }
  if (!b64) return null
  try {
    const bin = atob(b64.replace(/\s+/g, ''))
    let hex = ''
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0')
    return hex.toUpperCase()
  } catch {
    return null
  }
}

/** 纯 JS MD5（WebCrypto 不支持 MD5）。输入为字节数组，输出 32 位大写十六进制。 */
function md5Bytes(data: Uint8Array): string {
  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ])
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const len = data.length
  const paddedLen = (((len + 1 + 8 + 63) >>> 6) * 64)
  const bytes = new Uint8Array(paddedLen)
  bytes.set(data)
  bytes[len] = 0x80
  const dv = new DataView(bytes.buffer)
  const bitLen = len * 8
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true)
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let i = 0; i < paddedLen; i += 64) {
    const M = new Uint32Array(16)
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(i + j * 4, true)
    let A = a0, B = b0, C = c0, D = d0
    for (let j = 0; j < 64; j++) {
      let F: number, g: number
      if (j < 16) { F = (B & C) | (~B & D); g = j }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16 }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * j) % 16 }
      F = (F + A + K[j] + M[g]) | 0
      A = D; D = C; C = B
      B = (B + ((F << S[j]) | (F >>> (32 - S[j])))) | 0
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }
  function toHex(n: number): string {
    let s = ''
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    return s
  }
  return (toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0)).toUpperCase()
}

/** 将响应体（Buffer / Uint8Array / string）转为字节数组，用于计算 MD5 版本令牌 */
function bodyToBytes(body: unknown): Uint8Array | null {
  if (body == null) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  const b = body as { buffer?: ArrayBufferLike; byteOffset?: number; byteLength?: number }
  if (typeof b.byteLength === 'number' && b.buffer && typeof b.byteOffset === 'number') {
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  }
  return null
}

/**
 * 统一的“版本令牌”（OSS ETag / Content-MD5 本质都是对象内容的 MD5）：
 * 1. 优先取规范化后的 ETag 头（去引号）；
 * 2. 其次取 Content-MD5 头（base64 → hex）；
 * 3. 最后兜底直接对响应体字节算 MD5 —— 这是最关键的兜底：OSS 对较大的 JSON
 *    响应（如项目 tasks.json）会在传输层 gzip，ali-oss 在这种响应头里既不含
 *    ETag 也不暴露 Content-MD5，只有计算正文 MD5 才能拿到与 PUT 返回一致的
 *    版本令牌，从而避免 CAS 把每次写入都误判为“他端修改冲突”。
 * 所有读取/写入 etag 缓存的地方都应传入 body，保证令牌格式一致。
 */
export function versionToken(
  headers: Record<string, unknown> | undefined,
  body?: unknown,
): string | null {
  const fromHeader = getEtag(headers) ?? getContentMd5Hex(headers)
  if (fromHeader) return fromHeader
  const bytes = bodyToBytes(body)
  if (bytes) return md5Bytes(bytes)
  return null
}

/** 读取远端对象内容 + ETag；文件不存在时返回 null（不抛错） */
async function fetchRemote<T>(client: OssClient, key: string): Promise<{ content: T | null; etag: string | null }> {
  try {
    const res = await client.get(key)
    if (res.res.status === 404) return { content: null, etag: null }
    return {
      content: JSON.parse(res.content.toString()) as T,
      etag: versionToken(res.res.headers as Record<string, unknown>, res.content),
    }
  } catch (e) {
    const err = e as { code?: string | number; status?: number }
    if (err.status === 404 || err.code === 'NoSuchKey') return { content: null, etag: null }
    throw e
  }
}

/**
 * 条件写入（读-写模式，避免 OSS 不支持 If-Match）：
 * - 传了 knownEtag：先 GET 远端，ETag 与 knownEtag 一致才无条件 PUT；不一致返回 conflict（含远端内容）。
 * - 没传 knownEtag（首次新建）：远端已存在则返回 conflict 供调用方合并；不存在则直接创建。
 */
export async function compareAndSwapPut<T>(
  client: OssClient,
  key: string,
  local: T,
  knownEtag?: string,
): Promise<CasResult<T>> {
  const { content: remoteContent, etag: remoteEtag } = await fetchRemote<T>(client, key)
  const remoteExists = remoteEtag !== null && remoteContent !== null

  const isConflict = knownEtag
    ? !remoteExists || remoteEtag !== knownEtag
    : remoteExists

  if (isConflict) {
    return { ok: false, reason: 'conflict', remote: remoteContent, remoteEtag }
  }

  // 远端与期望一致（或远端不存在且是新建）：无条件覆盖写入
  const body = JSON.stringify(local)
  const res = await client.put(key, new Blob([body], { type: 'application/json' }))
  return { ok: true, etag: versionToken(res.res.headers as Record<string, unknown>, body) ?? '' }
}

/** 时间比较：a 比 b 新则 >0，相等则 =0，更旧则 <0 */
function compareTime(a: string, b: string): number {
  return (a || '').localeCompare(b || '')
}

/**
 * 合并两个任务列表（本地 vs 远端）：
 * - 只在一侧出现的任务直接保留；
 * - 两侧都出现：updatedAt 更新的覆盖，相等时以本地为准（本地为最近一次用户操作）。
 */
export function mergeTasks(local: Task[], remote: Task[]): Task[] {
  const byId = new Map<string, Task>()
  // 先放本地：远端仅在“严格更新”时才覆盖，保证秒级时间戳相等时本地修改不丢失
  for (const t of local) {
    if (!byId.has(t.id) || compareTime(t.updatedAt, byId.get(t.id)!.updatedAt) > 0) byId.set(t.id, t)
  }
  for (const t of remote) {
    const r = byId.get(t.id)
    if (!r || compareTime(t.updatedAt, r.updatedAt) > 0) byId.set(t.id, t)
  }
  return [...byId.values()]
}

/** 合并多个“已从活跃列表移除的任务”集合（回收站 tombstone：含已删除与已完成）；同 id 保留 updatedAt 最新的 tombstone */
export function mergeDeletedTombstones(...groups: Task[][]): Task[] {
  const byId = new Map<string, Task>()
  for (const group of groups) {
    for (const t of group) {
      const cur = byId.get(t.id)
      if (!cur || compareTime(t.updatedAt, cur.updatedAt) > 0) byId.set(t.id, t)
    }
  }
  return [...byId.values()]
}

/**
 * 应用“删除墓碑”：本地已软删（deleted）的任务，若远端活跃列表出现同 id，
 * 只有远端版本严格更新时才允许“复活”，否则保持删除，避免删除冲突后任务复活（BUG-19）。
 */
export function applyDeletedTombstones(active: Task[], deleted: Task[]): Task[] {
  if (!deleted.length) return active
  const deletedById = new Map(deleted.map((d) => [d.id, d]))
  return active.filter((a) => {
    const d = deletedById.get(a.id)
    if (!d) return true
    // 远端严格更新于本地删除时间 → 视为另一端的“重建”，允许保留；否则维持删除
    return compareTime(a.updatedAt, d.updatedAt) > 0
  })
}

/** 合并两个项目列表（按 id 去重，保留两侧全部项目；同 id 以远端为基准） */
function mergeProjects(local: Project[], remote: Project[]): Project[] {
  const byId = new Map<string, Project>()
  for (const p of remote) byId.set(p.id, p)
  for (const p of local) {
    if (!byId.has(p.id)) byId.set(p.id, p)
  }
  return [...byId.values()]
}

/** 已删除项目作为 tombstone：活跃列表中同 id 项目一律剔除，避免同一项目双存在 */
export function applyDeletedProjectTombstones(active: Project[], deleted: DeletedProject[]): Project[] {
  if (!deleted.length) return active
  const deletedIds = new Set(deleted.map((d) => d.id))
  return active.filter((p) => !deletedIds.has(p.id))
}

/** 合并已删除项目列表（按 id 去重，同 id 以远端为基准） */
function mergeDeletedProjects(local: DeletedProject[], remote: DeletedProject[]): DeletedProject[] {
  const byId = new Map<string, DeletedProject>()
  for (const p of remote) byId.set(p.id, p)
  for (const p of local) {
    if (!byId.has(p.id)) byId.set(p.id, p)
  }
  return [...byId.values()]
}

/**
 * 合并用户统计（多端冲突时用）：
 * - firstProjectAt：取最早的非空值，绝不覆盖/绝不清零（一旦写入永不变更）；
 * - daily：同一天取两端增量之和（不同天的记录自然累加）；新写入的任务状态按任务 ID
 *   逐项合并，避免已同步过的累计值再次相加。绝不从任务列表重算。
 */
export function mergeStats(local: UserStats, remote: UserStats): UserStats {
  const daily: Record<string, StatsDailyEntry> = {}
  const allKeys = new Set([
    ...Object.keys(local.daily ?? {}),
    ...Object.keys(remote.daily ?? {}),
  ])
  for (const k of allKeys) {
    const a = local.daily?.[k]
    const b = remote.daily?.[k]
    if (!a) daily[k] = b
    else if (!b) daily[k] = a
    else {
      const aHasTasks = a.tasks != null
      const bHasTasks = b.tasks != null
      const ts = a.ts > b.ts ? a.ts : b.ts
      if (!aHasTasks && !bHasTasks) {
        daily[k] = { v: a.v + b.v, ts }
      } else {
        const tasks: Record<string, StatsTaskDelta> = {}
        for (const map of [a.tasks, b.tasks]) {
          if (!map) continue
          for (const [id, entry] of Object.entries(map)) {
            const cur = tasks[id]
            if (!cur || compareTime(entry.ts, cur.ts) > 0) tasks[id] = { ...entry }
          }
        }
        let v = 0
        for (const entry of Object.values(tasks)) v += entry.v
        // 旧数据没有逐任务记录时，把整条净增量当作独立的存量计入，避免迁移后丢数
        if (!aHasTasks) v += a.v
        if (!bHasTasks) v += b.v
        daily[k] = { v, ts, tasks }
      }
    }
  }
  const candidates = [local.firstProjectAt, remote.firstProjectAt].filter(
    (v): v is string => !!v,
  )
  candidates.sort((a, b) => (a < b ? -1 : 1))
  return {
    firstProjectAt: candidates[0] ?? undefined,
    daily,
    updated_at: new Date().toISOString(),
  }
}

/**
 * 快照保存完成后把合并结果回填内存：
 * - 远端新增的日期直接并入；
 * - 当天没有比快照更新的本地改动时，用合并后的条目替换，界面立即看到远端增量；
 * - 当天在快照之后又改过则保留内存版，避免覆盖新改动，下一次 save 的 CAS 再合并远端。
 */
export function mergeStatsAfterSave(current: UserStats, saved: UserStats, snapshot: UserStats): UserStats {
  const daily: Record<string, StatsDailyEntry> = { ...current.daily }
  for (const [key, savedEntry] of Object.entries(saved.daily ?? {})) {
    const currentEntry = current.daily?.[key]
    const snapshotEntry = snapshot.daily?.[key]
    if (!currentEntry) {
      daily[key] = savedEntry
    } else if (snapshotEntry && JSON.stringify(currentEntry) === JSON.stringify(snapshotEntry)) {
      daily[key] = savedEntry
    }
  }
  return {
    firstProjectAt: current.firstProjectAt ?? saved.firstProjectAt,
    daily,
    updated_at: new Date().toISOString(),
  }
}

/** 合并 profile：项目列表按 id 合并，updated_at 更新为最新 */
export function mergeProfile(local: Profile, remote: Profile): Profile {
  const deletedProjects = mergeDeletedProjects(local.deletedProjects ?? [], remote.deletedProjects ?? [])
  return {
    projects: applyDeletedProjectTombstones(
      mergeProjects(local.projects ?? [], remote.projects ?? []),
      deletedProjects,
    ),
    deletedProjects,
    updated_at: new Date().toISOString(),
  }
}
