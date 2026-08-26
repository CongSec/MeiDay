import type { Task } from '@/types'
import { dateKeyOf } from './time'
import { isNewStyleRepeat, isRepeatDay } from './repeat'

/** 任务是否显示在今日任务视图（与侧栏角标共用同一判断，避免两处逻辑分叉） */
export function isTaskVisibleToday(t: Task, today: string): boolean {
  if (t.status === 'deleted') return false
  if (t.status === 'completed') return dateKeyOf(t.updatedAt) === today
  const rule = t.repeat
  // 新模型重复任务：只在「匹配重复规则的那一天」显示（不再以提醒时间/起止时间为准）；
  // 未到首次出现日或已过结束日期都不显示。
  if (rule && isNewStyleRepeat(rule) && rule.start) {
    if (rule.endAfter && today > rule.endAfter) return false
    return today >= rule.start && isRepeatDay(rule, rule.start, today)
  }
  const startDay = t.startTime ? dateKeyOf(t.startTime) : null
  const endDay = t.endTime ? dateKeyOf(t.endTime) : null
  const remindToday = !!t.reminderTime && dateKeyOf(t.reminderTime) === today
  // 没有任何开始/截止时间约束的待办：仅当提醒时间命中今天才显示；
  // 未定日期任务属于所属项目，不自动进入今日视图（项目新建任务默认开始时间为空）
  if (startDay === null && endDay === null) return remindToday
  const inRange = (startDay === null || today >= startDay) && (endDay === null || today <= endDay)
  return inRange || remindToday
}
