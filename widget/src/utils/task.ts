import { addDays, dateKeyOf, diffDaysKey, nowIso, todayKey } from './time'
import { isNewStyleRepeat, isRepeatDay } from './repeat'
import type { Subtask, Task } from '@/types'

/** 新建一个空的子任务（时间字段空字符串表示未设置，与任务保持一致） */
export function newSubtask(): Subtask {
  const now = nowIso()
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    startTime: '',
    endTime: '',
    reminderTime: null,
    completed: false,
    createdAt: now,
    updatedAt: now,
    attachments: [],
  }
}

/** 归一化任务：兼容旧数据（无 subtasks 字段 / 字段缺省） */
export function normalizeTask(t: Task): Task {
  if (!t.subtasks) t.subtasks = []
  if (!t.attachments) t.attachments = []
  for (const s of t.subtasks) {
    if (!s.startTime) s.startTime = ''
    if (!s.endTime) s.endTime = ''
    if (s.reminderTime === undefined || s.reminderTime === null) s.reminderTime = null
    if (!s.description) s.description = ''
    if (s.completed === undefined) s.completed = false
    if (!s.attachments) s.attachments = []
  }
  return t
}

export function normalizeTasks(list: Task[]): Task[] {
  return list.map(normalizeTask)
}

/** 子任务中未完成且有提醒时间的数量（用于提醒同步） */
export function pendingSubtaskReminders(t: Task): Subtask[] {
  return t.subtasks.filter((s) => s.reminderTime && !s.completed)
}

/** 单个候选（主任务或子任务）的排序参考时间：提醒时间 > 开始时间（都没有返回 null，无时间任务排最后） */
function subtaskSortTime(reminderTime: string | null | undefined, startTime: string): { iso: string; day: string; rank: 1 | 2 } | null {
  if (reminderTime) return { iso: reminderTime, day: dateKeyOf(reminderTime), rank: 1 }
  if (startTime) return { iso: startTime, day: dateKeyOf(startTime), rank: 2 }
  return null
}

/** 排序参考时间比较：同一天按「提醒 > 开始」类型优先级；不同一天所有时间同一级别，按实际时间先后（无时间排最后） */
export function compareSortTime(
  a: { iso: string; day: string; rank: 1 | 2 } | null,
  b: { iso: string; day: string; rank: 1 | 2 } | null,
): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  if (a.day === b.day) {
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.iso.localeCompare(b.iso)
  }
  return a.iso.localeCompare(b.iso)
}

/** 主任务「组有效时间」：主任务自身 + 各未完成子任务按规则最靠前的一个（地位同等，取最早）；
 *  全无时间返回 null（无时间任务排最后）。 */
export function taskEffectiveSortTime(t: Task): { iso: string; day: string; rank: 1 | 2 } | null {
  let best = subtaskSortTime(t.reminderTime, t.startTime)
  for (const s of t.subtasks ?? []) {
    if (s.completed) continue
    const st = subtaskSortTime(s.reminderTime, s.startTime)
    if (st && (!best || compareSortTime(st, best) < 0)) best = st
  }
  return best
}

/** 主任务「组截止时间」：主任务自身 + 各未完成子任务最早的 endTime（全无返回 ''，
 *  供从未拖拽项目按截止时间兜底排序与 sort 平局比较）。 */
export function taskEffectiveEndTime(t: Task): string {
  let best = t.endTime || ''
  for (const s of t.subtasks ?? []) {
    if (s.completed || !s.endTime) continue
    if (!best || s.endTime < best) best = s.endTime
  }
  return best
}

/** 子任务列表排序：一旦被手动拖拽过（存在 sort 值）就按 sort 升序（未分配 sort 的新子任务补末尾），
 *  手动顺序在加载/同步合并后保持；从未拖拽过则按「提醒 > 开始 > 更新时间」自动排序（最早在前）。 */
export function sortSubtasks(list: Subtask[]): Subtask[] {
  const hasSort = list.some((s) => s.sort !== undefined)
  if (hasSort) {
    return [...list].sort((a, b) => {
      const sa = a.sort ?? Number.MAX_SAFE_INTEGER
      const sb = b.sort ?? Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return (a.endTime || '').localeCompare(b.endTime || '') || a.updatedAt.localeCompare(b.updatedAt)
    })
  }
  return [...list].sort((a, b) => {
    const c = compareSortTime(subtaskSortTime(a.reminderTime, a.startTime), subtaskSortTime(b.reminderTime, b.startTime))
    if (c !== 0) return c
    return a.updatedAt.localeCompare(b.updatedAt)
  })
}

/** 任务是否「已到截止时间或提醒时间」（用于今日任务/项目页置顶）：
 *  - 仅未完成（pending）任务参与；
 *  - 截止时间（endTime）或提醒时间（reminderTime）任一已到/已过即命中；
 *  - 主任务与各未完成子任务地位同等：任一子任务的截止/提醒时间已到同样置顶；
 *  - 新模型重复任务：仅重复日当天参与，按「当天这一次」顺延后的截止/提醒时间判断，
 *    避免用模板中陈旧的锚点时间把重复任务永久置顶（子任务无重复规则，同样按当天顺延判断）。 */
export function isTaskPastDue(task: Task, now = Date.now()): boolean {
  if (task.status !== 'pending') return false
  const rule = task.repeat
  const passed = (iso: string | null | undefined): boolean => {
    if (!iso) return false
    return new Date(iso).getTime() <= now
  }
  if (rule && isNewStyleRepeat(rule) && rule.start) {
    const today = todayKey()
    if (rule.endAfter && today > rule.endAfter) return false
    if (!isRepeatDay(rule, rule.start, today)) return false
    const instancePassed = (iso: string | null | undefined): boolean => {
      if (!iso) return false
      const offset = diffDaysKey(dateKeyOf(iso), today)
      return new Date(addDays(iso, offset)).getTime() <= now
    }
    if (instancePassed(task.endTime) || instancePassed(task.reminderTime)) return true
    return (task.subtasks ?? []).some((s) => !s.completed && (instancePassed(s.endTime) || instancePassed(s.reminderTime)))
  }
  if (passed(task.endTime) || passed(task.reminderTime)) return true
  return (task.subtasks ?? []).some((s) => !s.completed && (passed(s.endTime) || passed(s.reminderTime)))
}

/** 将任务列表按「已到截止/提醒时间」稳定分区：命中者保持原相对顺序排到最前，其余保持原顺序在后。 */
export function pinOverdueFirst(list: Task[]): Task[] {
  const pinned: Task[] = []
  const rest: Task[] = []
  for (const t of list) {
    if (isTaskPastDue(t)) pinned.push(t)
    else rest.push(t)
  }
  return [...pinned, ...rest]
}
