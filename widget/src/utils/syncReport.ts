import { api, getToken, type SyncChangeItem, type SyncResType } from '@/api/client'
import { idbDel, idbGet, idbPut } from '@/utils/idb'

/**
 * 同步上报助手：把"某类资源已写入 OSS"这一事实报告给中心服务器。
 *
 * - 上报是纯加速信号：即使丢失，其它设备也会在 2 秒轮询 + 全量兜底中补上，
 *   因此绝不阻塞保存流程；
 * - 上报先落到 IDB 待发队列，由轮询循环（或登出前）统一冲刷：离线时保存成功的
 *   变更不会丢，网络恢复后由 flushPendingSyncReports 补报，保证其它设备能看到；
 * - 同一用户的「入队 + 上报 + 清空」用互斥锁串行化，避免并发写同一个 IDB 队列
 *   时互相覆盖（把未上报的新事件误清掉）；
 * - 队列成员去重：同一 (用户, 资源, 项目) 只要队列里还有未上报的条目就不再重复入队。
 *   不用"时间戳窗口"去重——上报成功会整队清空，若清空后 1 秒内的同类写入被时间窗口
 *   丢弃，这次变更就永远不会广播给其它设备（漏同步的经典成因）。
 */

const PENDING_KEY_PREFIX = 'sync:pending:'
// 每用户异步互斥锁：队列的任何读写/上报/清空都串行执行
const mutexes = new Map<string, Promise<void>>()

function pendingKey(username: string): string {
  return `${PENDING_KEY_PREFIX}${username}`
}

async function loadPending(username: string): Promise<SyncChangeItem[]> {
  return (await idbGet<SyncChangeItem[]>('kv', pendingKey(username))) ?? []
}

async function savePending(username: string, events: SyncChangeItem[]): Promise<void> {
  if (events.length) await idbPut('kv', pendingKey(username), events)
}

/** 串行化同一用户的队列操作；前一个操作（含失败）完成后才执行下一个。 */
function withLock<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(username) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  // 只保留最新尾巴；resolve 后旧链可被 GC，不会无限增长
  mutexes.set(
    username,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** 锁内：把一条变更事件写入待发队列（同资源只保留最新一条即可触发其它设备拉取）。 */
async function enqueueLocked(username: string, resType: SyncResType, projectId: string | null): Promise<void> {
  const pending = await loadPending(username)
  const filtered = pending.filter(
    (e) => !(e.res_type === resType && (e.project_id ?? null) === projectId),
  )
  filtered.push({ res_type: resType, project_id: projectId })
  await savePending(username, filtered)
}

/** 上报结果：version = 服务端最新总版本号；ids = 本次插入的事件 id（供精确排除"自己刚上报的"） */
export interface FlushResult {
  version: number
  ids: number[]
}

/** 锁内：上报并清空队列；成功返回 {version, ids}，无可上报/失败返回 undefined。 */
async function flushLocked(username: string): Promise<FlushResult | undefined> {
  if (!getToken()) return undefined
  const pending = await loadPending(username)
  if (!pending.length) return undefined
  try {
    const r = await api.reportSyncChanges(pending)
    await idbDel('kv', pendingKey(username))
    return { version: r.version, ids: r.ids ?? [] }
  } catch {
    /* 网络/后端不可达：保留待发队列，下次轮询重试 */
    return undefined
  }
}

/** 入队一次变更事件（不等待）。username 由调用方（store 内已有 auth.username）传入，避免 utils 依赖 pinia。 */
export function queueSyncChange(
  username: string,
  resType: SyncResType,
  projectId?: string | null,
): void {
  if (!username || typeof window === 'undefined') return
  const pid = projectId ?? null
  // 去重只看"队列里是否还有该资源未上报的条目"，不再用时间戳窗口：
  // 旧实现是「距上次入队 <1s 就丢弃」，而队列会在每次上报成功后被整队清空，
  // 因此"入队 → 上报成功清空 → 1 秒内再次写入"这一序列里，第二次写入会被永久丢弃，
  // 其它设备再也收不到通知（且后端不会补发，事件被视为已消费）。
  // 只入队、不在此处立即上报：上报统一由 2 秒轮询循环（或登出前）执行。
  void withLock(username, async () => {
    const pending = await loadPending(username)
    if (pending.some((e) => e.res_type === resType && (e.project_id ?? null) === pid)) return
    await enqueueLocked(username, resType, pid)
  })
}

/** 冲刷该用户的全部待发上报（轮询循环 / 登出前调用）；返回服务端版本号与本次插入的事件 id。 */
export async function flushPendingSyncReports(username: string): Promise<FlushResult | undefined> {
  if (!username || typeof window === 'undefined') return undefined
  return withLock(username, () => flushLocked(username))
}
