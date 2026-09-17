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

/** 任务是否「已到截止时间或提醒时间」（用于今日任务/项目页置顶）：
 *  - 仅未完成（pending）任务参与；
 *  - 截止时间（endTime）或提醒时间（reminderTime）任一已到/已过即命中；
 *  - 新模型重复任务：仅重复日当天参与，按「当天这一次」顺延后的截止/提醒时间判断，
 *    避免用模板中陈旧的锚点时间把重复任务永久置顶。 */
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
    return instancePassed(task.endTime) || instancePassed(task.reminderTime)
  }
  return passed(task.endTime) || passed(task.reminderTime)
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
