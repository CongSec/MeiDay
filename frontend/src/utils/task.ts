import { nowIso } from './time'
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
