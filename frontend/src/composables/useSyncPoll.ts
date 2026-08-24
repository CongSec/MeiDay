import { ref } from 'vue'
import { api, ApiError, type SyncStateItem } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useStatsStore } from '@/stores/stats'
import { idbGet, idbPut } from '@/utils/idb'
import { flushPendingSyncReports } from '@/utils/syncReport'
import { UNCATEGORIZED } from '@/types'

/**
 * 同步协调轮询：每隔固定间隔向中心服务器查询"总版本号 + 变更列表"，
 * 有变化时只从 OSS 拉取变化的资源并与本地合并（沿用现有 updatedAt + CAS 逻辑）。
 *
 * - 纯 2 秒轮询（无 SSE）：十几人在线时峰值约 7~8 req/s，2h4g 服务器无压力；
 * - 上报(报告变更)与拉取分离：本端先补报离线期间的待发上报，再判断是否需要拉取，
 *   避免把自己刚上报的变更再拉回来一次；
 * - 失败退避：网络/后端不可达时逐步拉长间隔（最多 30s），恢复后立即重试；
 * - 后台标签页放慢到 15s 轮询，回到前台立即同步一次。
 */

const POLL_INTERVAL_MS = 2000
const MAX_BACKOFF_MS = 30_000
const HIDDEN_INTERVAL_MS = 15_000
const VERSION_KEY_PREFIX = 'sync:version:'

const active = ref(false)
let timer: number | undefined
let stopped = false
let intervalMs = POLL_INTERVAL_MS

function versionKey(username: string): string {
  return `${VERSION_KEY_PREFIX}${username}`
}

async function loadVersion(username: string): Promise<number> {
  return (await idbGet<number>('kv', versionKey(username))) ?? 0
}

async function saveVersion(username: string, v: number): Promise<void> {
  // 版本 0 无需写入（新用户）；只有真正有版本号才持久化
  if (v > 0) await idbPut('kv', versionKey(username), v)
}

/** 全量同步：与手动刷新一致，拉全部项目 + 统计 + profile 合并。
 *  返回是否全部拉取成功（有项目失败时不推进游标，下一轮重试）。 */
async function fullSync(): Promise<boolean> {
  const projects = useProjectsStore()
  const tasks = useTasksStore()
  const stats = useStatsStore()
  await projects.flushProfile()
  await projects.load()
  await stats.load()
  // 今日任务跨项目顺序表：独立小文件，随全量同步一并刷新
  await tasks.loadTodayOrder()
  const projectIds = [...projects.projects.map((p) => p.id), UNCATEGORIZED]
  // 本地缓存不完整（全新设备/首登/缓存被清）时无法判断哪些项目今日有任务：
  // 必须全量同步所有项目，否则即使服务端要求全量，今日视图/侧栏角标仍是空的，
  // 直到手动点开项目才拉取数据。已有完整缓存时只刷「今日相关」项目 + 未分类，
  // 避免每次全量同步都下载所有项目（几百个项目时数据包/内存开销巨大）。
  const cachedIds = await tasks.loadFromIdb(projectIds)
  const fullyCached = projectIds.every((id) => cachedIds.includes(id))
  const ids = fullyCached
    ? [...new Set([UNCATEGORIZED, ...tasks.todayRelevantProjectIds(projectIds)])]
    : projectIds
  const failed = await tasks.syncAll(ids)
  return failed === 0
}

/** 按变更列表只拉变化的资源；返回是否全部拉取成功。
 *  单资源失败不中断其它资源，但调用方应据此不推进游标，下一轮重试失败资源。 */
async function pullChanges(changes: SyncStateItem[]): Promise<boolean> {
  const projects = useProjectsStore()
  const tasks = useTasksStore()
  const stats = useStatsStore()
  const seen = new Set<string>()
  let allOk = true
  for (const c of changes) {
    const key = `${c.res_type}:${c.project_id ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      switch (c.res_type) {
        case 'profile':
          await projects.load()
          break
        case 'tasks': {
          if (c.project_id) await tasks.syncProject(c.project_id)
          break
        }
        case 'trash': {
          if (c.project_id) await tasks.loadTrash(c.project_id)
          break
        }
        case 'repeats': {
          if (c.project_id) await tasks.loadRepeats(c.project_id)
          break
        }
        case 'stats':
          await stats.load()
          break
        case 'today_order':
          await tasks.loadTodayOrder()
          break
        default:
          break
      }
    } catch (e) {
      const err = e as { code?: string | number; status?: number }
      // 远端文件不存在等：保留本地，视为无需处理
      if (err.code === 'NoSuchKey' || err.status === 404 || err.code === 'NoSuchBucket') continue
      // 其它错误：记录但继续拉剩余资源；游标不推进，下一轮会重试该资源
      allOk = false
      console.error('同步拉取失败', c.res_type, c.project_id, e)
    }
  }
  return allOk
}

/** 单次轮询：补报待发变更 -> 查版本 -> 拉变化 -> 全部成功才推进游标 */
async function pollOnce(): Promise<boolean> {
  const auth = useAuthStore()
  if (!auth.token || !auth.username) {
    stopSyncPoll()
    return true
  }
  try {
    // 1) 先把本地（含离线期间）的待发上报补报给中心服务器
    const reported = await flushPendingSyncReports(auth.username)
    let cur = await loadVersion(auth.username)
    if (reported !== undefined && reported > cur) cur = reported
    // 2) 查询服务端版本与变更
    const state = await api.getSyncState(cur)
    let pulledAll = true
    let cursor = cur
    if (state.full_sync) {
      pulledAll = await fullSync()
      cursor = state.version
    } else if (state.version > cur && cur > 0) {
      pulledAll = await pullChanges(state.changes)
      // 游标只能推进到“实际拉取到的最后一条事件 id”，不能直接用总版本号：
      // 服务端每次最多返回 _STATE_LIMIT(200) 条，若待处理事件超过 200 条（长时间
      // 离线连发 / 新设备首次登录），直接用 state.version 会跳过中间未拉取的事件，
      // 造成跨设备同步漏变更。推进到最后一条实际处理的事件 id，下一轮继续拉剩余部分。
      cursor = state.changes.length ? state.changes[state.changes.length - 1].id : state.version
    } else if (state.version > cur) {
      // 全新设备（本地无版本游标 cur=0）：本地没有任何缓存，无法判断哪些项目今日有任务，
      // 必须全量加载所有项目的任务文件（渐进分批），否则今日视图/侧栏角标为空，
      // 直到手动点开项目才从 OSS 拉取数据。加载成功后才对齐版本游标。
      const projects = useProjectsStore()
      const tasks = useTasksStore()
      await tasks.loadAllProgressive([...projects.projects.map((p) => p.id), UNCATEGORIZED])
      await tasks.loadTodayOrder()
      cursor = state.version
    }
    // 3) 只有全部拉取成功才推进本地版本游标；失败则不推进，下一轮重试失败资源
    if (pulledAll) await saveVersion(auth.username, cursor)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      stopSyncPoll()
      return true
    }
    return false
  }
}

async function tick(): Promise<void> {
  if (stopped) return
  const ok = await pollOnce()
  intervalMs = ok ? POLL_INTERVAL_MS : Math.min(intervalMs * 2, MAX_BACKOFF_MS)
  if (stopped) return
  const delay = document.hidden ? HIDDEN_INTERVAL_MS : intervalMs
  timer = window.setTimeout(tick, delay)
}

/** 启动轮询（幂等）。立即同步一次（补报离线期间的待发上报、落后过多时全量补拉），
 *  再进入 2 秒周期轮询。新设备(cur=0)启动时会全量加载所有项目任务（见 pollOnce）。 */
export function startSyncPoll(): void {
  const auth = useAuthStore()
  if (!auth.username || !auth.token) return
  if (active.value) return
  stopped = false
  active.value = true
  intervalMs = POLL_INTERVAL_MS
  void (async () => {
    const ok = await pollOnce()
    intervalMs = ok ? POLL_INTERVAL_MS : Math.min(intervalMs * 2, MAX_BACKOFF_MS)
    if (!stopped) timer = window.setTimeout(tick, intervalMs)
  })()
}

/** 停止轮询（登出 / 会话失效时调用） */
export function stopSyncPoll(): void {
  stopped = true
  active.value = false
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
}

// 回到前台 / 网络恢复时立即同步一次，不等下一个周期
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && active.value) {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      void tick()
    }
  })
  window.addEventListener('online', () => {
    if (active.value) {
      intervalMs = POLL_INTERVAL_MS
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      void tick()
    }
  })
}