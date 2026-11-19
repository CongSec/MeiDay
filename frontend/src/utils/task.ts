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

/** 重复任务判定：任务带重复规则（repeat 字段非空）即为重复任务。
 *  重复规则被移除（编辑去掉重复）后字段消失，自然回归普通任务；子任务无重复规则恒为 false。 */
export function isRepeatTask(t: Task | Subtask): boolean {
  return !!(t as Task).repeat
}

/** 无手动键时的自动排序：普通任务在前、重复任务整体在后（与已完成任务的区段边界由
 *  调用方的状态分组保证）。重复任务哪怕带提醒/开始/截止时间也不参与普通任务的排序竞争，
 *  只在重复任务内部沿用统一时间链（提醒 > 开始 > 创建时间）。 */
export function compareAutoTasks(
  a: Task | Subtask,
  b: Task | Subtask,
): number {
  const ra = isRepeatTask(a) ? 1 : 0
  const rb = isRepeatTask(b) ? 1 : 0
  if (ra !== rb) return ra - rb
  return compareTasksByTime(a, b)
}

/** 在 list 现有顺序中求 task 的时间落点下标：从段首起用统一时间链（提醒 > 开始 > 创建）
 *  向前扫描，遇到第一个「时间更晚」的任务即停，插在它前面；整段没有更晚任务时插到段尾。
 *  落点只由时间链决定，与其它任务的手动拖拽位置无关（列表若本就按时间排好，则等价于严格升序插入）。
 *  全程忽略各方已有的手动键（sort / todayOrder 下标），供「新建任务插入落点」与
 *  「编辑时间后归位」共用，保证两者的排序语义完全一致。 */
export function timeInsertIndex<T extends Task | Subtask>(
  list: T[],
  task: T,
  from = 0,
  to: number = list.length,
): number {
  let at = Math.max(0, from)
  const end = Math.min(to, list.length)
  while (at < end && compareTasksByTime(list[at], task) <= 0) at++
  return at
}

/** 求 pending 段内的落点下标（新建任务、编辑改时间/改重复属性后的归位共用）。
 *  list[0, bound) 必须都是 pending 任务（已完成等其余任务在 bound 之后）。
 *  - 普通任务：自上而下扫普通任务，落在「最后一条时间不晚于它的普通任务」之后；
 *    一条普通任务都没有则落在段首。**重复任务的位置完全不参与**——重复任务哪怕时间更早，
 *    也不影响普通任务的落点。
 *  - 重复任务（保底）：活动范围限定在「最后一条普通任务之后 → 段末」；范围内自上而下扫
 *    重复任务，落在「最后一条时间不晚于它的重复任务」之后；范围内没有更早的重复任务时，
 *    落在范围开头（即所有普通任务之后）。因此新建的重复任务永远排在普通任务之后。
 *  全程忽略手动键（sort / todayOrder 下标），与 timeInsertIndex 同一套时间链（提醒 > 开始 > 创建）。 */
export function repeatAwareInsertIndex<T extends Task | Subtask>(
  list: T[],
  task: T,
  bound: number = list.length,
): number {
  const end = Math.max(0, Math.min(bound, list.length))
  // 最后一条普通任务的下标：重复任务的保底边界（一条普通任务都没有时为 -1）
  let lastNormal = -1
  for (let i = 0; i < end; i++) {
    if (!isRepeatTask(list[i])) lastNormal = i
  }
  if (isRepeatTask(task)) {
    // 保底区：所有普通任务之后；区内按时间落到「最后一条不晚于它的重复任务」之后
    const floor = lastNormal + 1
    let at = floor
    for (let i = floor; i < end; i++) {
      if (!isRepeatTask(list[i])) continue
      if (compareTasksByTime(list[i], task) <= 0) at = i + 1
    }
    return at
  }
  // 普通任务：只跟普通任务比时间，落在最后一条「不晚于它」的普通任务之后
  let at = 0
  for (let i = 0; i < end; i++) {
    if (isRepeatTask(list[i])) continue
    if (compareTasksByTime(list[i], task) <= 0) at = i + 1
  }
  return at
}

/** 同 repeatAwareInsertIndex，但作用于「id 顺序表」（今日视图跨项目全局顺序表 todayOrder 用）。
 *  lookup 返回 id 对应的任务；查不到的 id（项目尚未加载的残留、历史死 id）按普通任务占位，
 *  但不参与时间比较（不改变落点）。规则与项目页完全一致：
 *  - 普通任务：落在最后一条「时间不晚于它」的普通任务之后；
 *  - 重复任务：保底在所有普通任务之后，区内落在最后一条「时间不晚于它」的重复任务之后。 */
export function repeatAwareInsertIndexForIds(
  ids: string[],
  task: Task,
  lookup: (id: string) => Task | undefined,
  bound: number = ids.length,
): number {
  const end = Math.max(0, Math.min(bound, ids.length))
  const isRepeatId = (id: string): boolean => {
    const t = lookup(id)
    return !!t && isRepeatTask(t)
  }
  let lastNormal = -1
  for (let i = 0; i < end; i++) {
    if (!isRepeatId(ids[i])) lastNormal = i
  }
  if (isRepeatTask(task)) {
    const floor = lastNormal + 1
    let at = floor
    for (let i = floor; i < end; i++) {
      if (!isRepeatId(ids[i])) continue
      const other = lookup(ids[i])
      if (other && compareTasksByTime(other, task) <= 0) at = i + 1
    }
    return at
  }
  let at = 0
  for (let i = 0; i < end; i++) {
    if (isRepeatId(ids[i])) continue
    const other = lookup(ids[i])
    if (other && compareTasksByTime(other, task) <= 0) at = i + 1
  }
  return at
}

/** 顺序表并集合并（todayOrder 的加载合并 / 多端冲突合并共用）：
 *  以 base 的顺序为准（base 为空时等价于直接采用 extra 的权威顺序），
 *  extra 里 base 没有的 id 按「与新建任务同一套落点」逐条插入。
 *
 *  三条不变量（这是「手动拖拽位置不被自动流程覆盖」的核心保障）：
 *  1) 绝不删除 base 里的任何 id —— base 代表已被采纳的权威/手动顺序；
 *  2) 绝不移动 base 里已有 id 的相对位置 —— 补登记只允许插入、不允许重排；
 *  3) 内存里查不到的 id（项目尚未加载 / 历史死 id）原样保留在 base 内，不参与时间比较。
 *
 *  base 为空时直接返回 extra（新设备/无缓存时，云端顺序本身就是权威，
 *  不能拿时间链重排一遍，否则会打乱他端已拖好的顺序）。 */
export function mergeOrderIds(
  base: string[],
  extra: string[],
  lookup: (id: string) => Task | undefined,
): string[] {
  const seen = new Set(base)
  if (!base.length) {
    const out = [...extra]
    for (const id of out) seen.add(id)
    return out
  }
  const out = [...base]
  for (const id of extra) {
    if (!id || seen.has(id)) continue
    const t = lookup(id)
    if (!t) {
      // 未加载进内存的任务：无法判定落点，追加到末尾（展示层会按可见性过滤，不误导用户）
      out.push(id)
      seen.add(id)
      continue
    }
    out.splice(repeatAwareInsertIndexForIds(out, t, lookup), 0, id)
    seen.add(id)
  }
  return out
}

/** 统一排序链（带手动键）：手动排序 > 提醒时间 > 开始时间 > 创建时间。
 *  manualA / manualB 为手动顺序值（今日视图为 todayOrder 下标、项目/子任务为 sort）。
 *  注意：只有双方都有手动键时才比较该键；缺失的一侧按 Number.MAX_SAFE_INTEGER 处理，
 *  即“没拖过（无 sort）”的任务会排在所有已拖过的任务之后——并非“跳过该键直接比时间”。
 *  需要忽略手动键的场景（新建落点 / 编辑时间归位）请直接用 compareTasksByTime /
 *  repeatAwareInsertIndex（带普通/重复分区的那套落点）。 */
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
 *  避免仅字段顺序/排序差异触发无意义写回与多端冲突误报。
 *
 *  undefined 必须与“键不存在”等价：写盘走 JSON.stringify，值为 undefined 的键会被丢弃、
 *  数组里的 undefined 会变成 null。若比较时不归一，内存里的显式 undefined
 *  （如 repeatProcessed = undefined / repeatOccurrence: undefined）就会被判成“内容不同”，
 *  使 syncProject 每一轮同步都无意义地回写 OSS 并广播事件（多端写放大、2 秒乒乓）。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      // 与 JSON.stringify 对齐：显式 undefined 的键视为不存在
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
