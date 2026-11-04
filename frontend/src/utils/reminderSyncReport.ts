import { idbDel, idbGet, idbPut } from '@/utils/idb'

/**
 * 提醒清单待报队列（BUG-1 修复：提醒上报"失败即丢"）。
 *
 * 任务提醒清单（PUT /api/reminders/sync）是服务器提醒的唯一事实来源：若上报失败，
 * 服务器 reminders 表缺行，reminder_worker 到点不会发信，用户"设了提醒却没收到"。
 * 与任务数据同步（syncReport.ts）不同，提醒上报原本是一次性请求、失败静默丢失。
 *
 * 本模块只存"待报标记"（不存 rows 快照）：rows 在上报时从 tasks store 实时重建
 * （后端 DELETE+INSERT 全量替换，重报最新清单天然幂等，避免存储过期数据）。
 * - markReminderSyncPending：上报前落盘标记——即使请求失败/页面关闭，标记已在 IDB；
 * - clearReminderSyncPending：上报成功后清除；
 * - hasReminderSyncPending：供轮询/登出判断是否需要补报。
 *
 * 与 syncReport 队列一致的语义：登出时先尽力冲刷；仍离线则保留标记，
 * 下次同账号登录由 2 秒轮询补报（idbClearUserCache 刻意不清除本前缀）。
 */
const PENDING_KEY_PREFIX = 'reminderSync:pending:'
// 每用户异步互斥锁：标记的读写/清除串行执行，避免并发写同一个 IDB key 互相覆盖
const mutexes = new Map<string, Promise<void>>()

function pendingKey(username: string): string {
  return `${PENDING_KEY_PREFIX}${username}`
}

/** 串行化同一用户的标记操作；前一个操作（含失败）完成后才执行下一个。 */
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

/** 上报前落盘"待报"标记：即使本次请求失败，标记已在 IDB，不会丢。 */
export async function markReminderSyncPending(username: string): Promise<void> {
  if (!username || typeof window === 'undefined') return
  await withLock(username, () => idbPut('kv', pendingKey(username), 1))
}

/** 上报成功后清除标记（无可上报内容时同样清除，避免残留）。 */
export async function clearReminderSyncPending(username: string): Promise<void> {
  if (!username || typeof window === 'undefined') return
  await withLock(username, () => idbDel('kv', pendingKey(username)))
}

/** 是否存在待报标记（供轮询/登出判断是否需要补报）。 */
export async function hasReminderSyncPending(username: string): Promise<boolean> {
  if (!username || typeof window === 'undefined') return false
  return (await idbGet<number>('kv', pendingKey(username))) === 1
}
