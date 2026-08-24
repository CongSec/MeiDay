import type { RepeatRule, Task } from '@/types'
import { addDays, addDaysKey, dateKeyOf, diffDaysKey, nowIso } from './time'
import { nextLegalWorkday } from './legalWorkday'

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 重复规则的展示文案（卡片徽标 / 弹窗提示） */
export function formatRepeat(rule?: RepeatRule | null): string {
  if (!rule) return ''
  const n = Math.max(1, rule.interval || 1)
  switch (rule.type) {
    case 'daily':
      return n > 1 ? `每 ${n} 天` : '每天'
    case 'weekly': {
      const wds = rule.weekdays?.length ? rule.weekdays.map((w) => WEEKDAY_NAMES[w]).join('、') : ''
      const base = n > 1 ? `每 ${n} 周` : '每周'
      return wds ? `${base} · ${wds}` : base
    }
    case 'workday':
      // 旧「每个工作日」并入「每个法定工作日」，仅兼容旧 OSS 数据
      return '每个法定工作日'
    case 'monthly': {
      const day = rule.monthDay ?? 1
      const base = n > 1 ? `每 ${n} 个月` : '每月'
      return `${base} · ${day} 日`
    }
    case 'legalWorkday':
      return '每个法定工作日'
  }
}

/** 月份加 N 个月（YYYY-MM-DD），day 用于指定日期并自动收敛到月末 */
function addMonthsKey(dateKey: string, months: number, day?: number): string {
  const [yStr, mStr, dStr] = dateKey.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  let ty = y
  let tm = m - 1 + months
  ty += Math.floor(tm / 12)
  tm = ((tm % 12) + 12) % 12
  const daysInMonth = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate()
  const d = Math.min(day ?? Number(dStr), daysInMonth)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(ty).padStart(4, '0')}-${pad(tm + 1)}-${pad(d)}`
}

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+08:00`).getDay()
}

/** 计算严格晚于 anchor（YYYY-MM-DD）的下一个重复日期；无后续日期返回 null */
export function nextRepeatDate(rule: RepeatRule, anchor: string): string | null {
  const n = Math.max(1, rule.interval || 1)
  switch (rule.type) {
    case 'daily':
      return addDaysKey(anchor, n)
    case 'weekly': {
      const wds = rule.weekdays?.length ? [...rule.weekdays].sort((a, b) => a - b) : null
      if (!wds) return addDaysKey(anchor, 7 * n)
      // 选定了多个星期时：同一“周期周”内的后续星期优先（如每周一周三，完成周一生周三），
      // 之后跳到下一周期周（周差是 interval 的整数倍）。周差用自 epoch 起的周序号计算。
      const anchorWeek = Math.floor(diffDaysKey('1970-01-01', anchor) / 7)
      // 最多覆盖到 下一个周期周（7n+6 天），再留一天兜底
      for (let i = 1; i <= 7 * n + 7; i++) {
        const d = addDaysKey(anchor, i)
        if (!wds.includes(weekdayOf(d))) continue
        const week = Math.floor(diffDaysKey('1970-01-01', d) / 7)
        if ((week - anchorWeek) % n === 0) return d
      }
      return null
    }
    case 'workday': {
      let d = addDaysKey(anchor, 1)
      for (let i = 0; i < 14; i++) {
        const wd = weekdayOf(d)
        if (wd >= 1 && wd <= 5) return d
        d = addDaysKey(d, 1)
      }
      return null
    }
    case 'monthly': {
      const day = rule.monthDay ?? Number(anchor.slice(8, 10))
      let d = addMonthsKey(anchor, n, day)
      // 若某月天数不足被收敛到 <= anchor 的同一天，再推一个周期
      if (d <= anchor) d = addMonthsKey(anchor, n * 2, day)
      return d
    }
    case 'legalWorkday':
      return nextLegalWorkday(anchor)
  }
}

/** 构造发给服务器的重复提醒规则：服务器只存这一条规则（JSON），
 *  发完邮件后由 worker 按周期自行推进 reminder_time，不预注册未来 N 条提醒。
 *  名称/描述/起止/提醒时间会上传服务器（邮件展示需要）；附件等敏感内容仍只在用户 OSS。 */
export function buildReminderPayload(task: Task): RepeatRule | undefined {
  const rule = task.repeat
  if (!rule) return undefined
  const payload: RepeatRule = { type: rule.type, interval: Math.max(1, rule.interval || 1) }
  if (rule.weekdays?.length) payload.weekdays = [...rule.weekdays]
  if (rule.monthDay) payload.monthDay = rule.monthDay
  if (rule.endAfter) payload.endAfter = rule.endAfter
  return payload
}

/** 把任务（含子任务）的开始/截止/提醒时间整体平移 N 天（用于重复模板物化对齐） */
export function shiftTaskTimes(task: Task, days: number): Task {
  const shift = (iso: string | null): string | null => (iso ? addDays(iso, days) : iso)
  return {
    ...task,
    startTime: task.startTime ? addDays(task.startTime, days) : '',
    endTime: task.endTime ? addDays(task.endTime, days) : '',
    reminderTime: shift(task.reminderTime),
    subtasks: (task.subtasks ?? []).map((s) => ({
      ...s,
      startTime: s.startTime ? addDays(s.startTime, days) : '',
      endTime: s.endTime ? addDays(s.endTime, days) : '',
      reminderTime: shift(s.reminderTime),
    })),
  }
}

/**
 * 计算重复任务的下一次出现（模板 + 显示日期 dueDate）。
 * - 模板属性与源任务完全一致（名称/描述/项目/附件/子任务），仅日期按周期顺延；
 * - 过期多日自动跳过缺失周期，保留“今天”这一次；
 * - endAfter 已过或规则无法推进时返回 null。
 */
export function buildRepeatOccurrence(task: Task, today: string): { template: Task; dueDate: string } | null {
  const rule = task.repeat
  if (!rule) return null
  const anchor = task.reminderTime || task.endTime || task.startTime
  const anchorKey = anchor ? dateKeyOf(anchor) : today
  let date = nextRepeatDate(rule, anchorKey)
  if (!date) return null
  let guard = 0
  while (date < today && guard < 400) {
    const nd = nextRepeatDate(rule, date)
    if (!nd || nd <= date) break
    date = nd
    guard++
  }
  if (rule.endAfter && date > rule.endAfter) return null
  const offset = diffDaysKey(anchorKey, date)
  const now = nowIso()
  const shift = (iso: string | null): string | null => (iso ? addDays(iso, offset) : iso)
  const template: Task = {
    ...task,
    id: crypto.randomUUID(),
    status: 'pending',
    isReminded: false,
    createdAt: now,
    updatedAt: now,
    startTime: task.startTime ? addDays(task.startTime, offset) : '',
    endTime: task.endTime ? addDays(task.endTime, offset) : '',
    reminderTime: task.reminderTime ? addDays(task.reminderTime, offset) : null,
    subtasks: (task.subtasks ?? []).map((s) => ({
      ...s,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      startTime: s.startTime ? addDays(s.startTime, offset) : '',
      endTime: s.endTime ? addDays(s.endTime, offset) : '',
      reminderTime: s.reminderTime ? addDays(s.reminderTime, offset) : null,
      attachments: [...(s.attachments ?? [])],
    })),
    attachments: [...(task.attachments ?? [])],
    repeat: { ...rule },
  }
  return { template, dueDate: date }
}
