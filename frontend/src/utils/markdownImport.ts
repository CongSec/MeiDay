import { fromLocalInput, nowIso } from './time'
import type { Project, Task } from '@/types'

export interface ParsedSubtask {
  name: string
  description: string
  startTime: string
  endTime: string
  reminderTime: string | null
  completed: boolean
}

export interface ParsedTask {
  name: string
  description: string
  startTime: string
  endTime: string
  reminderTime: string | null
  /** 文档里用 `- 项目：xxx` 显式指定的项目名（可选） */
  projectName: string
  subtasks: ParsedSubtask[]
}

export interface ImportResult {
  tasks: ParsedTask[]
  warnings: string[]
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/**
 * 解析并校验时间的日历合法性（月份 1-12、日期在当月范围内、时分秒 0-23 / 0-59）。
 * iso 为空表示格式无法识别或不合法；error 为可读原因（格式问题时为 undefined）。
 */
export function parseImportTimeEx(raw: string): { iso: string; error?: string } {
  const s = (raw || '').trim()
  let m = s.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?\s*[T ]\s*(\d{1,2}):(\d{2})/)
  if (!m) m = s.match(/^(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?$/)
  if (!m) return { iso: '' }
  const [, yS, moS, dS, hS, miS] = m
  const y = Number(yS)
  const mo = Number(moS)
  const d = Number(dS)
  const h = hS === undefined ? undefined : Number(hS)
  const mi = miS === undefined ? undefined : Number(miS)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (mo < 1 || mo > 12) return { iso: '', error: '月份需在 1-12' }
  if (d < 1 || d > daysInMonth(y, mo)) return { iso: '', error: '日期超出该月天数' }
  if (h !== undefined && (h < 0 || h > 23)) return { iso: '', error: '小时需在 0-23' }
  if (mi !== undefined && (mi < 0 || mi > 59)) return { iso: '', error: '分钟需在 0-59' }
  if (h === undefined) {
    // 仅日期：视为当天 00:00 开始
    return { iso: `${y}-${pad(mo)}-${pad(d)}T00:00:00+08:00` }
  }
  // h 与 mi 同时存在（正则两组一起捕获），此处已排除 h 为 undefined，mi 也必为数字
  return { iso: fromLocalInput(`${y}-${pad(mo)}-${pad(d)}T${pad(h as number)}:${pad(mi as number)}`) }
}

const KV_KEYS: Record<string, 'startTime' | 'endTime' | 'reminderTime' | 'project'> = {
  开始: 'startTime',
  开始时间: 'startTime',
  截止: 'endTime',
  截止时间: 'endTime',
  结束: 'endTime',
  结束时间: 'endTime',
  提醒: 'reminderTime',
  提醒时间: 'reminderTime',
  项目: 'project',
}

/**
 * 解析 Markdown 批量导入文本。
 * 格式（详见 README 与导入弹窗示例）：
 *   ## 任务名称              → 新任务
 *   - 开始：2026-08-18 09:00 → 设置字段（开始/截止/提醒/项目）
 *   ### 子任务名称           → 新子任务（后随文本为子任务描述）
 *   - [ ] 简单子任务         → 一行式简单子任务（[x] 表示已完成）
 *   其他文本                  → 追加到当前任务/子任务描述
 * 规则：文档含 ## 标题时，- [ ] 视为子任务；不含 ## 标题时，- [ ] 视为顶层任务。
 */
export function parseMarkdownImport(md: string): ImportResult {
  const warnings: string[] = []
  const tasks: ParsedTask[] = []
  let currentTask: ParsedTask | null = null
  let currentSub: ParsedSubtask | null = null

  const hasHeadings = /^##\s+/m.test(md)
  const lines = md.split(/\r?\n/)

  const appendText = (text: string) => {
    if (!currentTask) return
    if (currentSub) currentSub.description += (currentSub.description ? '\n' : '') + text
    else currentTask.description += (currentTask.description ? '\n' : '') + text
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const lineNo = i + 1

    // 单 # 标题 / 分割线：作为文档说明，静默忽略
    if (/^#{1}\s/.test(line) || /^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) continue

    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      const t: ParsedTask = {
        name: h2[1].trim() || '未命名任务',
        description: '',
        startTime: '',
        endTime: '',
        reminderTime: null,
        projectName: '',
        subtasks: [],
      }
      tasks.push(t)
      currentTask = t
      currentSub = null
      continue
    }

    const h3 = line.match(/^###\s+(.+)$/)
    if (h3) {
      if (!currentTask) {
        warnings.push(`第 ${lineNo} 行：子任务「${h3[1].trim()}」前没有所属任务，已忽略`)
        continue
      }
      const s: ParsedSubtask = {
        name: h3[1].trim() || '未命名子任务',
        description: '',
        startTime: '',
        endTime: '',
        reminderTime: null,
        completed: false,
      }
      currentTask.subtasks.push(s)
      currentSub = s
      continue
    }

    const kv = line.match(/^[-*]\s*(开始时间|开始|截止时间|截止|结束时间|结束|提醒时间|提醒|项目)\s*[:：]\s*(.+)$/)
    if (kv) {
      const field = KV_KEYS[kv[1]]
      const val = kv[2].trim()
      if (!currentTask) {
        warnings.push(`第 ${lineNo} 行：属性行前没有任务，已忽略：「${line}」`)
        continue
      }
      if (field === 'project') {
        if (currentSub) warnings.push(`第 ${lineNo} 行：子任务内不支持指定项目，已忽略`)
        else currentTask.projectName = val
        continue
      }
      const target = currentSub ?? currentTask
      const parsed = parseImportTimeEx(val)
      if (!parsed.iso) {
        warnings.push(
          `第 ${lineNo} 行：${kv[1]}时间「${val}」${parsed.error ? `不合法（${parsed.error}）` : '格式无法识别'}，已忽略`,
        )
        continue
      }
      target[field] = parsed.iso
      continue
    }

    const cb = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/)
    if (cb) {
      const name = cb[2].trim()
      if (!currentTask || !hasHeadings) {
        // 顶层 checkbox（文档无 ## 标题时所有 checkbox 均为顶层任务）
        const t: ParsedTask = {
          name: name || '未命名任务',
          description: '',
          startTime: '',
          endTime: '',
          reminderTime: null,
          projectName: '',
          subtasks: [],
        }
        tasks.push(t)
        currentTask = t
        currentSub = null
        continue
      }
      // 有 ## 标题：当前任务下的简单子任务
      const s: ParsedSubtask = {
        name: name || '未命名子任务',
        description: '',
        startTime: '',
        endTime: '',
        reminderTime: null,
        completed: cb[1].toLowerCase() === 'x',
      }
      currentTask.subtasks.push(s)
      currentSub = null // checkbox 子任务为一行式，后续文本回到任务描述
      continue
    }

    // 其余文本：去列表前缀后追加为描述
    appendText(line.replace(/^[-*]\s+/, ''))
  }

  return { tasks, warnings }
}

/**
 * 把解析结果构造成可入库的 Task[]（分配 id/时间戳、解析项目归属）。
 * projectName 精确或包含匹配项目名，未找到时回退 defaultProjectId 并给出提示。
 */
export function buildTasksFromImport(
  result: ImportResult,
  opts: { projects: Project[]; defaultProjectId: string },
): { tasks: Task[]; warnings: string[] } {
  const { projects, defaultProjectId } = opts
  const warnings = [...result.warnings]
  const now = nowIso()
  const resolveProject = (name: string): string => {
    if (!name) return defaultProjectId
    const found = projects.find((p) => p.name === name) ?? projects.find((p) => p.name.includes(name) || name.includes(p.name))
    if (!found) warnings.push(`未找到项目「${name}」，已归入默认项目`)
    return found?.id ?? defaultProjectId
  }

  const tasks: Task[] = result.tasks.map((pt) => ({
    id: crypto.randomUUID(),
    name: pt.name,
    description: pt.description,
    startTime: pt.startTime,
    endTime: pt.endTime,
    reminderTime: pt.reminderTime,
    projectId: resolveProject(pt.projectName),
    status: 'pending',
    isReminded: false,
    createdAt: now,
    updatedAt: now,
    subtasks: pt.subtasks.map((s) => ({
      id: crypto.randomUUID(),
      name: s.name,
      description: s.description,
      startTime: s.startTime,
      endTime: s.endTime,
      reminderTime: s.reminderTime,
      completed: s.completed,
      createdAt: now,
      updatedAt: now,
      attachments: [],
    })),
    attachments: [],
  }))
  return { tasks, warnings }
}
