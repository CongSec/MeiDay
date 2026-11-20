import { api, ApiError } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useTasksStore } from '@/stores/tasks'
import type { Task } from '@/types'
import { nowIso } from '@/utils/time'

/**
 * 远程任务投递（下拉）：外部系统调用「消息通知回调」时带了 project（项目名），
 * 服务端会先照常发通知邮件，再把任务投递到 pending_tasks；这里在同步轮询里认领并写进 OSS。
 *
 * 关键约束：
 *  - 只有网页端 / 手机 APP 调用本模块（client='web'）。桌面小组件（exe）是纯只读端，
 *    不引入本文件、也不会认领，因此 exe 端不会写 OSS；
 *  - 认领是服务端原子抢占 + 60 秒租约：同一行同一时刻只会被一个端拿到，
 *    因此多端同时在线也不会出现「两个端同时写同一条任务」；
 *  - 写入成功后必须 ack（服务端删行）；写入失败上报 fail，由服务端计数/判失败并发邮件，
 *    失败不会静默丢失，也不做任何界面提示。
 */

/** 无此项目：项目名只在客户端可见，重试也不会变对，服务端收到该原因直接判失败。 */
const REASON_NO_PROJECT = '无此项目'
/** 单轮最多处理条数（与服务端 CLAIM_BATCH 对齐） */
const MAX_PER_ROUND = 10

/** 同一时刻只允许一轮在跑：多个调用方（轮询/回到前台）并发会重复处理同一批 */
let inFlight: Promise<void> | null = null

/** 按项目名找项目 id：精确匹配全部同名项目（重名时每个项目各加一条），不做模糊匹配、不看回收站。 */
function matchProjectIds(name: string): string[] {
  const projects = useProjectsStore()
  const target = (name || '').trim()
  if (!target) return []
  return projects.projects.filter((p) => p.name.trim() === target).map((p) => p.id)
}

/** 构造一条待写入的任务（字段与任务弹窗新建时保持一致，避免 normalizeTask 产出脏数据）。 */
function buildTask(item: { title: string; content: string; start_time: string }, projectId: string): Task {
  const now = nowIso()
  const start = (item.start_time || '').trim() || now
  return {
    id: crypto.randomUUID(),
    name: (item.title || '').trim() || '【MeiDay 通知】',
    description: item.content || '',
    startTime: start,
    // 远程任务不设截止时间：结束时间留空（空串表示未设置，与新建子任务一致）
    endTime: '',
    reminderTime: null,
    projectId,
    status: 'pending',
    isReminded: false,
    createdAt: now,
    updatedAt: now,
    subtasks: [],
    attachments: [],
  }
}

/** 认领并落库一批远程任务。失败只上报给服务端（由其计数/通知），不抛给轮询方、不打扰用户。 */
async function drainOnce(): Promise<void> {
  const auth = useAuthStore()
  if (!auth.token || !auth.username) return
  // 必须先确认项目列表已加载：项目名 → id 的映射只存在于客户端
  const projects = useProjectsStore()
  if (!projects.loaded) return

  let items
  try {
    const r = await api.claimPendingTasks('web')
    items = r.items ?? []
  } catch (e) {
    if (e instanceof ApiError) {
      // 403：服务端认为本端是只读端，直接放弃（正常不会被触发）
      console.warn('[pending-tasks] 认领被拒', e.message)
    }
    return
  }
  if (!items.length) return

  const tasks = useTasksStore()
  const okIds: string[] = []
  for (const item of items.slice(0, MAX_PER_ROUND)) {
    const ids = matchProjectIds(item.project_name)
    if (!ids.length) {
      // 无此项目：直接判失败（服务端会发一封失败邮件，只发一次）
      try {
        await api.failPendingTasks(item.id, REASON_NO_PROJECT)
      } catch {
        /* 上报失败保持待认领，下一轮重试 */
      }
      continue
    }
    let allOk = true
    try {
      for (const pid of ids) {
        // 该项目任务未加载时先加载：否则 saveProjectNow 会用不完整列表覆盖 OSS
        if (!tasks.loadedProjects.includes(pid)) await tasks.loadProject(pid)
        if (!tasks.tasks[pid]) tasks.tasks[pid] = []
        // 幂等：同一任务 id 已存在（别的端已写入并同步过来）时跳过
        const exists = tasks.tasks[pid].some((t) => t.id === item.id)
        if (!exists) tasks.bulkAdd([buildTask(item, pid)])
        const saved = await tasks.saveProjectNow(pid)
        if (!saved) {
          allOk = false
          break
        }
      }
    } catch (e) {
      allOk = false
      console.warn('[pending-tasks] 写入远程任务失败', e)
    }
    if (allOk) okIds.push(item.id)
    else {
      try {
        await api.failPendingTasks(item.id, '写入 OSS 失败')
      } catch {
        /* 上报失败：租约到期后可被任意端重新认领 */
      }
    }
  }
  if (okIds.length) {
    try {
      await api.ackPendingTasks(okIds)
    } catch {
      /* 回执失败：记录仍会被重新认领，靠 id 幂等避免重复 */
    }
  }
}

/** 处理一轮远程任务投递（幂等、可重复调用；已有在跑的一轮时直接复用）。 */
export function drainPendingTasks(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = drainOnce()
    .catch(() => {
      /* 任何异常都不影响同步轮询 */
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
