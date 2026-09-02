import type { RepeatRule, Subtask, Task } from '@/types'
import { dateKeyOf } from './time'
import { isNewStyleRepeat, isRepeatDay } from './repeat'

/** 今日可见判断所需的公共字段（主任务与子任务共用同一套核心逻辑） */
interface TodayCandidate {
  status: 'pending' | 'completed'
  updatedAt: string
  startTime: string
  endTime: string
  reminderTime: string | null
  repeat?: RepeatRule | null
}

/** 今日可见核心逻辑（主任务与子任务共用，避免两处逻辑分叉）：
 *  - 已完成：仅「当天完成」显示；
 *  - 新模型重复任务：只在「匹配重复规则的那一天」显示（不再以提醒时间/起止时间为准），
 *    未到首次出现日或已过结束日期都不显示；
 *  - 普通任务：今天落在开始~截止范围，或提醒时间命中今天，即显示；
 *  - 没有任何开始/截止时间约束的待办：仅当提醒时间命中今天才显示；
 *    未定日期任务属于所属项目，不自动进入今日视图（项目新建任务默认开始时间为空）。 */
function isCandidateVisibleToday(c: TodayCandidate, today: string): boolean {
  if (c.status === 'completed') return dateKeyOf(c.updatedAt) === today
  const rule = c.repeat
  if (rule && isNewStyleRepeat(rule) && rule.start) {
    if (rule.endAfter && today > rule.endAfter) return false
    return today >= rule.start && isRepeatDay(rule, rule.start, today)
  }
  const startDay = c.startTime ? dateKeyOf(c.startTime) : null
  const endDay = c.endTime ? dateKeyOf(c.endTime) : null
  const remindToday = !!c.reminderTime && dateKeyOf(c.reminderTime) === today
  if (startDay === null && endDay === null) return remindToday
  const inRange = (startDay === null || today >= startDay) && (endDay === null || today <= endDay)
  return inRange || remindToday
}

/** 子任务是否今日可见：复用主任务逻辑（completed 映射为状态；子任务无重复规则） */
export function isSubtaskVisibleToday(s: Subtask, today: string): boolean {
  return isCandidateVisibleToday(
    {
      status: s.completed ? 'completed' : 'pending',
      updatedAt: s.updatedAt,
      startTime: s.startTime,
      endTime: s.endTime,
      reminderTime: s.reminderTime,
    },
    today,
  )
}

/** 任务是否显示在今日任务视图（与侧栏角标共用同一判断，避免两处逻辑分叉）。
 *  已删除不显示；已完成仅当天完成显示（父任务完成 = 子任务视为完成，不再被子任务重新拉回）；
 *  待办任务：自身可见，或任一子任务今日可见（子任务提醒/起止时间命中今天），即显示。 */
export function isTaskVisibleToday(t: Task, today: string): boolean {
  if (t.status === 'deleted') return false
  // 此处 t.status 已排除 'deleted'，可安全复用核心逻辑
  if (isCandidateVisibleToday(t as TodayCandidate, today)) return true
  // 已完成任务不被子任务重新拉回今日视图
  if (t.status !== 'pending') return false
  return (t.subtasks ?? []).some((s) => isSubtaskVisibleToday(s, today))
}

/** 子任务是否属于「未来」：未完成且开始时间在未来（复用主任务未来判断） */
export function isSubtaskFuture(s: Subtask, today: string): boolean {
  if (s.completed) return false
  if (!s.startTime) return false
  return dateKeyOf(s.startTime) > today
}

/** 是否属于「未来任务」：开始时间在未来、尚未开始的待办任务，
 *  或（存在未来子任务开始时间）的父任务。
 *  截止日期（endTime）在未来且未到期的任务不算未来任务（它们仍算今日待办）；
 *  新模型重复任务的未来出现由重复模板（repeats）承载，不在此判断。 */
export function isFutureTask(t: Task, today: string): boolean {
  if (t.status !== 'pending') return false
  const rule = t.repeat
  if (rule && isNewStyleRepeat(rule) && rule.start) return false
  if (t.startTime && dateKeyOf(t.startTime) > today) return true
  return (t.subtasks ?? []).some((s) => isSubtaskFuture(s, today))
}

