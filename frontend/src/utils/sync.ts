import type { OssClient } from '@/utils/oss'
import { canonicalJson } from '@/utils/task'
import type { DeletedProject, Profile, Project, StatsMonthEntry, Task, UserStats } from '@/types'

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
  | { ok: false; reason: 'remote-gone'; remote: null; remoteEtag: null }

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


/**
 * 大小写无关地读取响应头中的 Last-Modified（RFC 1123 时间串，如 'Wed, 21 Oct 2015 07:28:00 GMT'）。
 * 阿里云 OSS 的 GET 响应不带 ETag 头（只有 Content-MD5 + Last-Modified），且对
 * If-None-Match 条件请求不识别（实测带 Content-MD5 hex 永远回 200 全量），
 * 但对 If-Modified-Since 能正确回 304。因此读路径用 Last-Modified 做条件请求。
 */
export function lastModifiedOf(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'last-modified') {
      const v = String(headers[key] ?? '')
      return v || null
    }
  }
  return null
}

/** 由 etag 键派生对应的 Last-Modified 键：'lm:' 前缀 + 去掉 'etag:' 后的后缀。
 *  etag 键同时被 CAS 写路径复用（knownEtag 冲突检测），绝不能把时间写进 etag 键；
 *  Last-Modified 只用于读路径的 If-Modified-Since 条件请求，独立存放互不干扰。 */
export function lmKeyOf(etagKey: string): string {
  return 'lm:' + etagKey.replace(/^etag:/, '')
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

  if (knownEtag && !remoteExists) {
    // R3/R8 修复：本端此前同步过该键（knownEtag 存在）而远端对象已不存在——
    // 说明远端被清空/重置（如清空时间胶囊删除分片文件）。此时绝不能把本地缓存
    // 当作「新建」重新写回（否则已清空的数据被缓存复活），返回 remote-gone
    // 由调用方作废本地缓存并禁止写回。
    return { ok: false, reason: 'remote-gone', remote: null, remoteEtag: null }
  }

  const isConflict = knownEtag
    ? remoteEtag !== knownEtag
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
 * 同 id 任务“谁更新”的判定：updatedAt 严格更新者胜；
 * **updatedAt 平局时按内容指纹确定性裁决，而不是无条件“本地胜”**。
 *
 * 为什么平局不能本地胜：updatedAt 只精确到秒（utils/time.ts 的 nowIso），多端同时在线时
 * 平局很常见（典型场景：两端各自物化同一个重复日——任务 id 相同、updatedAt 都继承模板
 * 所以相同，只有 createdAt 是各自物化时刻而不同）。若平局时两端各自保留本地副本，
 * 两份内容永远不同，于是每轮 2 秒轮询都会「拉取 → 发现差异 → 回写 OSS → 上报事件 →
 * 对端再回写」，形成永不收敛的写放大/乒乓。按内容指纹裁决后，两端面对同一对候选必然
 * 选出同一个胜者，最多回写一次即收敛。
 */
function winsOver(a: Task, b: Task): boolean {
  const c = compareTime(a.updatedAt, b.updatedAt)
  if (c !== 0) return c > 0
  return canonicalJson(a) > canonicalJson(b)
}

/**
 * 合并两个任务列表（本地 vs 远端）：
 * - 只在一侧出现的任务直接保留；
 * - 两侧都出现：updatedAt 更新者胜，平局按内容指纹确定性裁决（见 winsOver）。
 */
export function mergeTasks(local: Task[], remote: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const t of local) {
    const cur = byId.get(t.id)
    if (!cur || winsOver(t, cur)) byId.set(t.id, t)
  }
  for (const t of remote) {
    const r = byId.get(t.id)
    if (!r || winsOver(t, r)) byId.set(t.id, t)
  }
  return [...byId.values()]
}

/**
 * 过滤出真正属于某项目的任务：丢弃“任务声明的 projectId 与所在文件项目不一致”的脏副本。
 *
 * 跨项目移动任务时，源项目 tasks.json 里若残留该任务的旧副本（其 projectId 已改为新项目，
 * 但轮询/CAS 冲突合并仍按“只在一侧出现则保留”把它并回源项目），会导致“源项目没删、目标项目
 * 多一条”的复制现象。此处按 projectId 识别并丢弃这类过期副本：
 * - 任务 projectId 明确且不等于当前项目文件 => 已移走/错位，丢弃；
 * - projectId 为 undefined 的历史数据 => 无法判定，一律保留，避免误删旧数据。
 */
export function filterTasksForProject(tasks: Task[], projectId: string): Task[] {
  return tasks.filter((t) => t.projectId === undefined || t.projectId === projectId)
}

/**
 * 按 id 去重（保留 updatedAt 最新的一份），展示/计数层的兜底。
 *
 * 跨项目移动任务后，源项目 OSS 文件里可能短暂残留该任务的旧副本（详见 filterTasksForProject），
 * 直接 Object.values(tasks).flat() 会把同一个任务渲染/计数两遍（BUG：重复任务显示）。
 * 这里按全局唯一 id 收敛：同一 id 只留 updatedAt 最新的一份，其余视为过期副本丢弃。
 * 副作用：this.all.find(id) 会稳定命中最新副本，完成任务/删除/编辑等操作作用于最新数据。
 */
export function dedupTasksById(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const t of tasks) {
    const cur = byId.get(t.id)
    // 平局同样按内容指纹裁决：保证同一份输入在任何端都收敛到同一副本（显示/计数一致）
    if (!cur || winsOver(t, cur)) byId.set(t.id, t)
  }
  return [...byId.values()]
}

/** 合并多个“已从活跃列表移除的任务”集合（回收站 tombstone：含已删除与已完成）；同 id 保留 updatedAt 最新的 tombstone */
export function mergeDeletedTombstones(...groups: Task[][]): Task[] {
  const byId = new Map<string, Task>()
  for (const group of groups) {
    for (const t of group) {
      const cur = byId.get(t.id)
      if (!cur || winsOver(t, cur)) byId.set(t.id, t)
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

/** 月份键正则：daily 的键若匹配它，说明已是月级兼容结构 `YYYY-MM` */
const MONTH_KEY_RE = /^\d{4}-\d{2}$/
/** 日期键正则：旧版按天结构 `YYYY-MM-DD`（需要迁移） */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 旧版按天结构（含 tasks 明细 / sealed 标记）的读取形状，仅迁移期使用 */
interface LegacyStatsEntry {
  v?: number
  ts?: string
  tasks?: Record<string, { v?: number; ts?: string }>
  sealed?: boolean
}
interface LegacyStats {
  firstProjectAt?: string
  daily?: Record<string, LegacyStatsEntry>
  updated_at?: string
}

/** Σ 月度兼容字段的 v（= 旧版客户端看到的“累计完成数”口径） */
export function sumMonthly(daily: Record<string, StatsMonthEntry> | undefined): number {
  let total = 0
  for (const k in daily ?? {}) total += Number(daily![k]?.v) || 0
  return total
}

/** 把任意格式的 stats 规范化成「月键兼容结构 + totalCompleted」（幂等，可反复执行）：
 *  - 旧版按天条目（YYYY-MM-DD，可能带 tasks 明细）→ 按月份求和归并；
 *  - 已是月键条目 → 直接并入；
 *  - totalCompleted：优先取显式字段；缺失（旧版写回时丢字段）→ 回退为 Σv，绝不归零；
 *  - 最后强制 Σv === totalCompleted（旧端可能只改了 daily 没改 totalCompleted）。
 *  返回值`changed` 表示结构确实变化（调用方据此决定是否写回 OSS）。
 *  ★ 防归零核心：旧端写回时会把 totalCompleted 字段丢掉，这里必须能从 daily 重建。 */
export function migrateLegacyStats(input: unknown): {
  stats: UserStats
  changed: boolean
  /** 是否包含旧版按天明细（需要重新落盘压缩） */
  hadDayKeys: boolean
} {
  const src = (input ?? {}) as LegacyStats
  const before = JSON.stringify(src)
  const daily: Record<string, StatsMonthEntry> = {}
  let hadDayKeys = false
  for (const key of Object.keys(src.daily ?? {})) {
    const entry = (src.daily ?? {})[key] ?? {}
    const keyIsMonth = MONTH_KEY_RE.test(key)
    if (!keyIsMonth && DAY_KEY_RE.test(key)) hadDayKeys = true
    // 非法键（既不是 YYYY-MM 也不是 YYYY-MM-DD）直接跳过：它们不可能来自本产品
    if (!keyIsMonth && !hadDayKeys) continue
    const mk = keyIsMonth ? key : key.slice(0, 7)
    const v = Number(entry.v) || 0
    const ts = typeof entry.ts === 'string' ? entry.ts : ''
    const prev = daily[mk]
    if (!prev) daily[mk] = { v, ts }
    else {
      prev.v += v
      if (ts > prev.ts) prev.ts = ts
    }
  }
  const monthlySum = sumMonthly(daily)
  const declared = (src as { totalCompleted?: unknown }).totalCompleted
  const hasDeclared = typeof declared === 'number' && Number.isFinite(declared)
  // 有显式值以它为准（它记录了“无法从 daily 推导”的历史），否则回退 Σv（防归零）
  const totalCompleted = hasDeclared ? Math.round(declared) : monthlySum
  const stats: UserStats = {
    firstProjectAt: typeof src.firstProjectAt === 'string' && src.firstProjectAt ? src.firstProjectAt : undefined,
    totalCompleted,
    daily,
    updated_at: typeof src.updated_at === 'string' && src.updated_at ? src.updated_at : new Date().toISOString(),
  }
  const changed = JSON.stringify(stats) !== before
  return { stats, changed, hadDayKeys }
}

/** 核对并修复 totalCompleted 与 Σdaily 的一致性（旧端可能只改了一个）：
 *  - 两者不一致时以 totalCompleted 为准修正 daily 的“差额”到当月（保留旧端写入的月度结构）；
 *  - 返回修复后的 stats（原地修改并返回同一对象）。 */
export function reconcileStats(stats: UserStats, monthKey: string, ts: string): UserStats {
  const monthlySum = sumMonthly(stats.daily)
  const diff = (Number(stats.totalCompleted) || 0) - monthlySum
  if (diff !== 0) {
    if (!stats.daily) stats.daily = {}
    const cur = stats.daily[monthKey]
    stats.daily[monthKey] = { v: (cur?.v ?? 0) + diff, ts: ts > (cur?.ts ?? '') ? ts : cur?.ts ?? ts }
  }
  return stats
}

/** 过渡期兼容字段清理：删除 daily（旧端已全部升级后才可调用）。
 *  删除后旧版客户端会显示 0，因此只允许在确认无旧端写入后手动/自动触发。 */
export function purgeCompatDaily(stats: UserStats): { stats: UserStats; changed: boolean } {
  if (stats.daily == null) return { stats, changed: false }
  const next: UserStats = {
    firstProjectAt: stats.firstProjectAt,
    totalCompleted: stats.totalCompleted,
    updated_at: new Date().toISOString(),
  }
  return { stats: next, changed: true }
}

/** 合并用户统计（多端冲突时用）：
 *  - firstProjectAt：取最早的非空值，绝不覆盖/绝不清零（一旦写入永不变更）；
 *  - totalCompleted：取 max（远端为 OSS 权威值）。**绝不相加**——两端都可能是同一批事件的
 *    不同快照，相加会把同一批历史重复计数；取 max 保证任何一端都不会把总数改小（防归零）；
 *  - daily（过渡期）：按月份取 ts 较新的一侧，保证 Σv 与 totalCompleted 的口径一致。
 *  绝不从任务列表重算。 */
export function mergeStats(local: UserStats, remote: UserStats): UserStats {
  const daily: Record<string, StatsMonthEntry> = {}
  const allKeys = new Set([...Object.keys(local.daily ?? {}), ...Object.keys(remote.daily ?? {})])
  for (const k of allKeys) {
    const a = local.daily?.[k]
    const b = remote.daily?.[k]
    if (!a) daily[k] = { ...b! }
    else if (!b) daily[k] = { ...a }
    else daily[k] = a.ts >= b.ts ? { ...a } : { ...b }
  }
  const candidates = [local.firstProjectAt, remote.firstProjectAt].filter((v): v is string => !!v)
  candidates.sort((a, b) => (a < b ? -1 : 1))
  return {
    firstProjectAt: candidates[0] ?? undefined,
    totalCompleted: Math.max(Number(local.totalCompleted) || 0, Number(remote.totalCompleted) || 0),
    daily,
    updated_at: new Date().toISOString(),
  }
}

/**
 * 快照保存完成后把合并结果回填内存（仅保留 firstProjectAt 的“不丢最早”语义；
 * totalCompleted/daily 以保存成功的合并结果为准，因为合并只可能变大不会回退）。 */
export function mergeStatsAfterSave(_current: UserStats, saved: UserStats, _snapshot: UserStats): UserStats {
  return mergeStats(saved, _current)
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
