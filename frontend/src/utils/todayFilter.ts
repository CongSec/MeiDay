import type { RepeatMaster, RepeatRule, Subtask, Task } from '@/types'
import { addDaysKey, dateKeyOf } from './time'
import { isNewStyleRepeat, isRepeatDay } from './repeat'

/** 今日/未来某天可见判断所需的公共字段（主任务与子任务共用同一套核心逻辑） */
interface TodayCandidate {
  status: 'pending' | 'completed'
  updatedAt: string
  startTime: string
  endTime: string
  reminderTime: string | null
  repeat?: RepeatRule | null
}

/** 某天可见核心逻辑（主任务与子任务共用，避免两处逻辑分叉）：
 *  - 已完成：仅「当天完成」显示；
 *  - 新模型重复任务：只在「匹配重复规则的那一天」显示（不再以提醒时间/起止时间为准），
 *    未到首次出现日或已过结束日期都不显示；
 *  - 普通任务：date 落在开始~截止范围，或提醒时间命中 date，即显示；
 *  - 没有任何开始/截止时间约束的待办：仅当提醒时间命中 date 才显示；
 *    未定日期任务属于所属项目，不自动进入今日视图（项目新建任务默认开始时间为空）。 */
function isCandidateVisibleOn(c: TodayCandidate, date: string): boolean {
  if (c.status === 'completed') return dateKeyOf(c.updatedAt) === date
  const rule = c.repeat
  if (rule && isNewStyleRepeat(rule) && rule.start) {
    if (rule.endAfter && date > rule.endAfter) return false
    return date >= rule.start && isRepeatDay(rule, rule.start, date)
  }
  const startDay = c.startTime ? dateKeyOf(c.startTime) : null
  const endDay = c.endTime ? dateKeyOf(c.endTime) : null
  const remindOnDate = !!c.reminderTime && dateKeyOf(c.reminderTime) === date
  // 提醒时间已过（今天早些时候 / 过去某天）：未完成任务当天仍显示，直到完成为止
  // （子任务与主任务共用同一核心逻辑，子任务提醒已过同样会把任务拉回今日视图）
  const remindPassed = !!c.reminderTime && dateKeyOf(c.reminderTime) < date
  if (startDay === null && endDay === null) return remindOnDate || remindPassed
  const inRange = (startDay === null || date >= startDay) && (endDay === null || date <= endDay)
  return inRange || remindOnDate || remindPassed
}

/** 子任务是否会在某天被今日视图显示（子任务无重复规则）。
 *  始终按「未完成 + 起止/提醒命中」判定：子任务完成当天不再把父任务拉回今日视图
 *  （父任务自身的显示只由父任务自己的状态/时间决定），修复「完成子任务后，
 *  无任何时间的父任务凭空出现在今日视图」的 bug。 */
function isSubtaskVisibleOn(s: Subtask, date: string): boolean {
  return isCandidateVisibleOn(
    {
      status: 'pending',
      updatedAt: s.updatedAt,
      startTime: s.startTime,
      endTime: s.endTime,
      reminderTime: s.reminderTime,
    },
    date,
  )
}

/** 任务是否会在某天被今日视图显示：
 *  已删除不显示；已完成仅当天完成显示（父任务完成 = 子任务视为完成，不再被子任务重新拉回）；
 *  待办任务：自身可见，或任一子任务该天可见（子任务提醒/起止时间命中该天），即显示。 */
export function isTaskVisibleOn(t: Task, date: string): boolean {
  if (t.status === 'deleted') return false
  // 此处 t.status 已排除 'deleted'，可安全复用核心逻辑
  if (isCandidateVisibleOn(t as TodayCandidate, date)) return true
  // 已完成任务不被子任务重新拉回今日视图
  if (t.status !== 'pending') return false
  return (t.subtasks ?? []).some((s) => isSubtaskVisibleOn(s, date))
}

/** 任务是否显示在今日任务视图（与侧栏角标共用同一判断，避免两处逻辑分叉） */
export function isTaskVisibleToday(t: Task, today: string): boolean {
  return isTaskVisibleOn(t, today)
}

/** 任务在 [today+1, today+windowDays] 窗口内「首次会被今日视图显示」的出现日；
 *  窗口内任何一天都不会显示返回 null（已完成的、或窗口外才开始的任务不在此列）。
 *  用于「未来任务」区：完整套用今日视图的判定规则
 *  （开始命中 / 开始~截止覆盖那天 / 提醒命中那天 / 重复规则命中那天 / 子任务同规则）。 */
export function nextVisibleDateInWindow(t: Task, today: string, windowDays = 30): string | null {
  if (t.status === 'deleted') return null
  for (let i = 1; i <= windowDays; i++) {
    const date = addDaysKey(today, i)
    if (isTaskVisibleOn(t, date)) return date
  }
  return null
}

/** 未来 30 天窗口内「会被今日视图显示」的任务（按任务去重，取最早出现日），
 *  供今日视图「未来任务」区使用。
 *  - 今日任务视图已经显示的任务不再进入未来区（例如开始/截止区间覆盖今天又延续到
 *    未来的进行中任务、每天重复的任务），避免同一任务两处重复展示；
 *  - 其余任务逐日套用 isTaskVisibleOn（开始、开始~截止覆盖、提醒命中、
 *    重复规则命中、子任务同规则），30 天窗口外才开始/提醒的任务不收集；
 *  - 重复模板（完成重复任务后生成）：dueDate 落在窗口内，且按今日视图规则当天会显示
 *    才收集（物化后即成为当天可见的待办任务）。 */
export function collectFutureVisibleTasks(
  allTasks: Task[],
  repeats: Record<string, RepeatMaster[]>,
  today: string,
  windowDays = 30,
): { task: Task; date: string }[] {
  const out: { task: Task; date: string }[] = []
  for (const t of allTasks) {
    // 今日任务视图已经显示的任务不再进入未来任务区（避免同一任务两处重复展示），
    // 例如开始/截止区间覆盖今天又延续到未来的进行中任务、以及每天重复的任务。
    if (isTaskVisibleToday(t, today)) continue
    const date = nextVisibleDateInWindow(t, today, windowDays)
    if (date) out.push({ task: t, date })
  }
  const last = addDaysKey(today, windowDays)
  for (const pid of Object.keys(repeats)) {
    for (const m of repeats[pid] ?? []) {
      if (m.dueDate > today && m.dueDate <= last && isTaskVisibleOn(m.template, m.dueDate)) {
        out.push({ task: m.template, date: m.dueDate })
      }
    }
  }
  // 同一任务只展示一次（最早出现日在前）；按出现日期升序
  const seen = new Set<string>()
  return out
    .filter((x) => {
      if (seen.has(x.task.id)) return false
      seen.add(x.task.id)
      return true
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
}

/** 重复任务在 date 当天是否「活跃」（首次出现日已到且当天是重复日）：
 *  项目视图用它过滤——未到首次出现日 / 非重复日的重复任务不在项目列表显示，
 *  只进今日视图的「未来任务」区；普通任务与老模型重复任务（无 rule.start）恒为 true。 */
export function isRepeatTaskActiveOn(t: Task, date: string): boolean {
  const rule = t.repeat
  if (!rule || !isNewStyleRepeat(rule) || !rule.start) return true
  if (rule.endAfter && date > rule.endAfter) return false
  return date >= rule.start && isRepeatDay(rule, rule.start, date)
}
