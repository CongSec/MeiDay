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

/** 排序键缺失判定：null / undefined / 空串 都视为未设置（缺失排在设置有值之后） */
function keyOrNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  return v
}

/** 单个键比较：有值在前（升序），缺失（null/空串）排后 */
function cmpKey(a: string | null | undefined, b: string | null | undefined): number {
  const ka = keyOrNull(a)
  const kb = keyOrNull(b)
  if (ka === kb) return 0
  if (ka === null) return 1
  if (kb === null) return -1
  return ka.localeCompare(kb)
}

/** 统一排序链（无手动键）：提醒时间 > 开始时间 > 创建时间。
 *  只取主任务/子任务自身字段（不含 endTime、不含子任务聚合）；升序；缺失键排后。 */
export function compareTasksByTime(
  a: { reminderTime?: string | null; startTime?: string; createdAt: string },
  b: { reminderTime?: string | null; startTime?: string; createdAt: string },
): number {
  const c1 = cmpKey(a.reminderTime, b.reminderTime)
  if (c1 !== 0) return c1
  const c2 = cmpKey(a.startTime, b.startTime)
  if (c2 !== 0) return c2
  return (a.createdAt || '').localeCompare(b.createdAt || '')
}

/** 统一排序链（带手动键）：手动排序 > 提醒时间 > 开始时间 > 创建时间。
 *  manualA / manualB 为手动顺序值（今日视图为 todayOrder 下标、项目/子任务为 sort），
 *  缺失时该键跳过（直接落到下一键比较）。 */
export function compareTaskChain(
  a: Task | Subtask,
  b: Task | Subtask,
  manualA?: number,
  manualB?: number,
): number {
  const ma = manualA ?? Number.MAX_SAFE_INTEGER
  const mb = manualB ?? Number.MAX_SAFE_INTEGER
  if (ma !== mb) return ma - mb
  return compareTasksByTime(a, b)
}

/** 子任务列表排序：统一链「手动 sort > 提醒 > 开始 > 创建时间」。
 *  拖拽过的子任务按 sort 升序（手动顺序在加载/同步合并后保持），
 *  未拖过的按时间链自动排序（最早在前）。 */
export function sortSubtasks(list: Subtask[]): Subtask[] {
  return [...list].sort((a, b) => compareTaskChain(a, b, a.sort, b.sort))
}

/** 规范化 JSON 序列化：递归对对象键排序、数组保持原顺序。
 *  用于“内容是否真的变了”的语义比较，忽略对象字段顺序差异，
 *  避免仅字段顺序/排序差异触发无意义写回与多端冲突误报。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
