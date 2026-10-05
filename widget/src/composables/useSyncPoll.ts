import { ref } from 'vue'
import { api, ApiError, type SyncStateItem } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import { useStatsStore } from '@/stores/stats'
import { idbGet, idbPut } from '@/utils/idb'
import { flushPendingSyncReports } from '@/utils/syncReport'
import { useWidgetStore } from '@/stores/widget'
import { persistSessionToConfig } from '@/utils/config'

/**
 * 桌面小组件的同步轮询（精简版，完全只读）。
 *
 * 与主应用 useSyncPoll 逻辑一致：
 *  - 纯 2 秒轮询中心服务器的总版本号 + 变更列表；
 *  - 本端先补报离线期间的待发上报，再判断是否需要拉取（只读端自身不再产生新上报）；
 *  - 按变更类型只拉变化的资源，全部成功才推进游标；
 *  - 失败指数退避（最多 30s）；401 停止；后台标签页放慢到 15s，回前台立即同步。
 *
 * 与主应用的差异：widget 的 tasks store 没有 syncAll / loadTrash / flushProfile，
 * 这里用「逐项目 syncProject」代替；trash 变更直接忽略（今日视图不展示回收站）；
 * 重复任务到期由 App/网页端物化，小组件不再自行物化写盘（只读）。
 */

const POLL_INTERVAL_MS = 2000
const MAX_BACKOFF_MS = 30_000
const HIDDEN_INTERVAL_MS = 15_000
const VERSION_KEY_PREFIX = 'sync:version:'

const active = ref(false)
/** 本会话是否已成功拉取过数据（区分“正在同步…”与“今日没有待办任务”） */
const synced = ref(false)

/** 读取“已同步”状态（供原生窗口决定显示“正在同步…”还是真实数据） */
export function isSynced(): boolean {
  return synced.value
}
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
  if (v > 0) await idbPut('kv', versionKey(username), v)
}

/** 远端文件不存在等：保留本地，视为无需处理 */
function isIgnorableError(e: unknown): boolean {
  const err = e as { code?: string | number; status?: number }
  return err?.code === 'NoSuchKey' || err?.code === 'NoSuchBucket' || err?.status === 404
}

async function syncProjectOnce(projectId: string): Promise<void> {
  const tasks = useTasksStore()
  await tasks.syncProject(projectId)
}

/** 首次登录 / 无同步日志（version=0，如测试号）时的引导加载。
 *  等同网页端 TodayView 挂载逻辑：先从 IDB 判断缓存是否齐全，
 *  再按需拉取相关项目任务与今日顺序。重复任务到期由 App/网页端物化，
 *  小组件只读展示物化结果，不自行物化。 */
export async function bootstrapLoad(): Promise<void> {
  const projects = useProjectsStore()
  const tasks = useTasksStore()
  if (!projects.loaded) await projects.load()
  const allIds = [...projects.projects.map((p) => p.id)]
  // 直接加载全部项目：loadProject 会先从 IDB 恢复内存缓存，再做条件 GET 合并远程，
  // 未变动的项目返回 304，开销很小。
  // 注意不要照搬网页端“全缓存→只刷今日相关项目”的优化：widget 冷启动时内存
  // s.tasks/s.repeats 还是空的，todayRelevantProjectIds 会算出空集，导致页面空白。
  await tasks.loadAllProgressive(allIds)
  await tasks.loadTodayOrder()
  synced.value = true
}

/** version=0（无同步日志，如测试号）时的兆底周期刷新间隔 */
const ZERO_VERSION_REFRESH_MS = 15_000
let lastZeroBootstrapAt = 0

async function bootstrapThrottled(): Promise<boolean> {
  const now = Date.now()
  if (now - lastZeroBootstrapAt < ZERO_VERSION_REFRESH_MS) return true
  lastZeroBootstrapAt = now
  try {
    await bootstrapLoad()
    return true
  } catch (e) {
    return false
  }
}
/** 全量同步：刷新 profile / stats / 今日顺序，并拉取（今日相关）项目任务。 */
async function fullSync(): Promise<boolean> {
  const projects = useProjectsStore()
  const tasks = useTasksStore()
  const stats = useStatsStore()
  await projects.load()
  await stats.load()
  await tasks.loadTodayOrder()
  const projectIds = [...projects.projects.map((p) => p.id)]
  // 本地缓存不完整（全新设备/首登/缓存被清）时无法判断哪些项目今日有任务：全量拉取所有项目。
  const cachedIds = await tasks.loadFromIdb(projectIds)
  const fullyCached = projectIds.every((id) => cachedIds.includes(id))
  const ids = fullyCached
    ? [...new Set([...tasks.todayRelevantProjectIds(projectIds)])]
    : projectIds
  let failed = 0
  for (const id of ids) {
    try {
      await syncProjectOnce(id)
    } catch (e) {
      if (isIgnorableError(e)) continue
      failed++
      console.error('全量同步拉取失败', id, e)
    }
  }
  return failed === 0
}

/** 按变更列表只拉变化的资源；返回是否全部成功（失败则不推进游标，下一轮重试）。 */
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
        case 'tasks':
          if (c.project_id) await syncProjectOnce(c.project_id)
          break
        case 'repeats':
          if (c.project_id) await tasks.loadRepeats(c.project_id)
          break
        case 'stats':
          await stats.load()
          break
        case 'today_order':
          await tasks.loadTodayOrder()
          break
        case 'trash':
          // 回收站/时间胶囊变更：重新拉取对应项目，用回收站墓碑剔除已入舱/已软删任务
          if (c.project_id) await syncProjectOnce(c.project_id)
          break
        default:
          break
      }
    } catch (e) {
      if (isIgnorableError(e)) continue
      allOk = false
      console.error('同步拉取失败', c.res_type, c.project_id, e)
    }
  }
  return allOk
}

/** 单次轮询：确保 profile 已加载 -> 补报待发变更 -> 查版本 -> 拉变化 -> 全部成功才推进游标 */
async function pollOnce(): Promise<boolean> {
  const auth = useAuthStore()
  if (!auth.token || !auth.username) {
    stopSyncPoll()
    return true
  }
  try {
    const projects = useProjectsStore()
    const tasks = useTasksStore()
    if (!projects.loaded) await projects.load()
    const reported = await flushPendingSyncReports(auth.username)
    let cur = await loadVersion(auth.username)
    if (reported !== undefined && reported > cur) cur = reported
    const state = await api.getSyncState(cur)
    let pulledAll = true
    let cursor = cur
    if (state.full_sync) {
      pulledAll = await fullSync()
      cursor = state.version
    } else if (state.version > cur && cur > 0) {
      pulledAll = await pullChanges(state.changes)
      // 游标只能推进到“实际拉取到的最后一条事件 id”，不能直接用总版本号：
      // 服务端每次最多返回 200 条，若待处理事件超过 200 条，直接用 state.version
      // 会跳过中间未拉取的事件，造成跨设备同步漏变更。
      cursor = state.changes.length ? state.changes[state.changes.length - 1].id : state.version
    } else if (state.version > cur) {
      // 全新设备（本地无游标 cur=0）：本地无缓存，无法判断哪些项目今日有任务，
      // 必须全量加载所有项目任务（渐进分批），否则今日视图为空。
      const projectIds = [...projects.projects.map((p) => p.id)]
      await tasks.loadAllProgressive(projectIds)
      await tasks.loadTodayOrder()
      cursor = state.version
    } else if (state.version === 0) {
      // 无同步日志的账号（如测试号）：since=0 永远拿不到 changes，
      // 只能周期性引导重载，保证网页端新任务/测试号清空重灌能同步进来。
      pulledAll = await bootstrapThrottled()
    }
    if (pulledAll) await saveVersion(auth.username, cursor)
    if (pulledAll) synced.value = true
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

/** 启动轮询（幂等）。立即同步一次，再进入 2 秒周期轮询。 */
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
/* ---------------- 离线恢复：解锁失败后等待网络恢复自动回到今日视图 ---------------- */
let recoveryArmed = false
let recoveryTimer: number | undefined
let recoveryBackoffMs = 5000
let recoveryOnlineHandler: (() => void) | undefined

/**
 * 完整恢复：重新解锁 OSS 凭证 → 引导加载 → 启动轮询 → 回到今日视图。
 * 供 main.ts 解锁失败后的自动重试，以及“同步”按钮在轮询未启动时调用。
 * 返回是否已进入轮询。
 */
export async function recoverSession(): Promise<boolean> {
  const auth = useAuthStore()
  if (!auth.isLoggedIn) return false
  // 轮询已在运行：无需恢复
  if (active.value) return true
  const unlocked = await auth.tryAutoUnlock()
  if (!unlocked || !auth.isLoggedIn) return false
  try {
    await bootstrapLoad()
  } catch (e) {
    console.error('[widget] 引导加载失败（网络恢复后会自动重试）', e)
  }
  startSyncPoll()
  useWidgetStore().setMode('view')
  await persistSessionToConfig().catch(() => {})
  return true
}

export function disarmRecovery(): void {
  recoveryArmed = false
  if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer)
  recoveryTimer = undefined
  if (recoveryOnlineHandler) {
    window.removeEventListener('online', recoveryOnlineHandler)
    recoveryOnlineHandler = undefined
  }
  recoveryBackoffMs = 5000
}

/**
 * 挂起“待网络恢复”自动重试：解锁失败（如开机时还没网）时调用。
 * 监听 online 事件 + 指数退避定时兜底（某些网络环境不会可靠触发 online），
 * 网络恢复后自动重新解锁并进入同步。
 */
export function armRecoveryLoop(): void {
  if (recoveryArmed) return
  if (typeof window === 'undefined') return
  recoveryArmed = true
  recoveryBackoffMs = 5000
  const attempt = async () => {
    if (!recoveryArmed) return
    // 用户已登出（token 被清空）：没有可恢复的会话，解除循环，避免空转
    if (!useAuthStore().isLoggedIn) {
      disarmRecovery()
      return
    }
    const ok = await recoverSession()
    if (ok) {
      disarmRecovery()
    } else {
      recoveryBackoffMs = Math.min(recoveryBackoffMs * 2, 60_000)
      recoveryTimer = window.setTimeout(attempt, recoveryBackoffMs)
    }
  }
  recoveryOnlineHandler = () => {
    if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer)
    recoveryTimer = undefined
    void attempt()
  }
  window.addEventListener('online', recoveryOnlineHandler)
  // 兜底定时器：即使 online 事件没触发，也按退避周期重试
  recoveryTimer = window.setTimeout(attempt, recoveryBackoffMs)
}


/** 手动立即同步一次（标题栏刷新按钮）；轮询未启动时返回 false */
export function syncNow(): Promise<boolean> {
  const auth = useAuthStore()
  if (!active.value) {
    // 轮询未启动（离线待恢复 / 冷启动解锁失败）：有登录态则执行完整恢复，而不是直接返回 false
    if (!auth.isLoggedIn) return Promise.resolve(false)
    return recoverSession()
  }
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  return pollOnce().then((ok) => {
    intervalMs = ok ? POLL_INTERVAL_MS : Math.min(intervalMs * 2, MAX_BACKOFF_MS)
    if (!stopped) timer = window.setTimeout(tick, intervalMs)
    return ok
  })
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
