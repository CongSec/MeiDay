/** 一个任务/子任务附件的元信息（二进制内容直接存于用户 OSS，此处只存元数据） */
export interface AttachmentMeta {
  id: string
  name: string
  size: number
  type: string
  /** OSS 对象 key（位于 users/{username}/attachments/... 下） */
  key: string
  uploadedAt: string
}

export interface Subtask {
  id: string
  name: string
  description: string
  startTime: string
  endTime: string
  reminderTime: string | null
  completed: boolean
  createdAt: string
  updatedAt: string
  /** 附件列表（旧数据可能缺失，读取时统一补空数组） */
  attachments: AttachmentMeta[]
}

// 列表含 'workday' 仅为兼容 OSS 旧数据；新数据不再使用（与「每个法定工作日」合并，选项已移除）
export type RepeatType = 'daily' | 'weekly' | 'workday' | 'monthly' | 'legalWorkday'

export const REPEAT_TYPES: RepeatType[] = ['daily', 'weekly', 'monthly', 'legalWorkday']

/** 任务重复规则：重复生成的下一次任务，所有属性（名称/描述/时间/子任务/附件）保持一致，仅日期按周期顺延 */
export interface RepeatRule {
  type: RepeatType
  /** 每 N 个周期重复一次（天/周/月），默认 1 */
  interval: number
  /** 按周重复时指定星期几（0=周日…6=周六）；为空则按开始日期所在星期 */
  weekdays?: number[]
  /** 按月重复时的日期（1-31），默认按原日期 */
  monthDay?: number
  /** 可选：重复到此日期（含）为止，之后不再生成 */
  endAfter?: string
  /** 新模型标记：首次出现日（YYYY-MM-DD），作为每周/每月重复的相位锚点；老重复数据无此字段，自动走旧逻辑 */
  start?: string
}

export interface Task {
  id: string
  name: string
  description: string
  startTime: string
  endTime: string
  reminderTime: string | null
  projectId: string
  status: 'pending' | 'completed' | 'deleted'
  isReminded: boolean
  createdAt: string
  updatedAt: string
  /** 排序位置（拖拽排序后写入；旧数据缺失时按截止时间排序） */
  sort?: number
  /** 子任务列表（旧数据可能缺失，读取时统一补空数组） */
  subtasks: Subtask[]
  /** 附件列表（旧数据可能缺失，读取时统一补空数组） */
  attachments: AttachmentMeta[]
  /** 重复规则（旧数据可能缺失，视为不重复） */
  repeat?: RepeatRule
}

/** 未分类任务的项目 id：存于独立文件 today.json，今日视图展示 */
export const UNCATEGORIZED = ''

export interface Project {
  id: string
  name: string
  color: string
  icon: string
}

/** 已删除（放入回收站）的项目：保留原信息用于「恢复整个项目」，deletedAt 为删除时间 */
export interface DeletedProject extends Project {
  deletedAt: string
}

export interface Profile {
  projects: Project[]
  /** 已删除项目（保留元数据以便整项目恢复）；旧数据可能缺失 */
  deletedProjects?: DeletedProject[]
  updated_at: string
}

/** 单任务当天完成/取消状态：v=1 表示当前已完成，v=0 表示当天已取消完成 */
export interface StatsTaskDelta {
  v: 0 | 1
  ts: string
}

/** 单日净增记录：v 为当天“完成(+1)/取消完成(-1)”净增量，ts 为该日最后一次写入时间戳 */
export interface StatsDailyEntry {
  v: number
  ts: string
  /** 多端合并用的逐任务状态，key 为任务 id；旧数据可能缺失 */
  tasks?: Record<string, StatsTaskDelta>
}

/**
 * 用户统计（全部存于用户 OSS，不上服务器）：
 * - firstProjectAt：首次创建项目时间，一旦写入永不可修改、绝不回填重算；
 * - daily：按天净增量累计，当前累计完成任务数 = 所有 v 之和；
 *   tasks 记录当天各任务的最近完成/取消状态，用于多端合并去重。
 * 注意：禁止任何“清零/从任务列表重算”的逻辑，只能做增量维护。
 */
export interface UserStats {
  /** 首次创建项目时间（东八区 ISO），一旦写入不再修改 */
  firstProjectAt?: string
  /** 按天净增量：{ '2026-08-21': { v: 2, ts: '2026-08-21T...', tasks } } */
  daily: Record<string, StatsDailyEntry>
  updated_at: string
}


/** 隐私日记：附件密文的元信息（二进制密文存于 users/{username}/diary/files/{fileId}） */
export interface DiaryFileRef {
  fileId: string
  name: string
  size: number
  mime: string
  /** 音频时长（秒），仅 audio 消息 */
  duration?: number
}

export type DiaryMessageType = 'text' | 'file' | 'audio'

/** 隐私日记：单条消息（整日文件整体加密，消息内容均为解密后内存态） */
export interface DiaryMessage {
  id: string
  type: DiaryMessageType
  /** 文本消息正文 */
  text?: string
  /** 文件/音频消息的附件引用 */
  file?: DiaryFileRef
  createdAt: string
  /** 追加到历史某天时为 true（聊天框显示「追加」标签） */
  appended?: boolean
}

/** 隐私日记：一次会话（一个批次）的消息内容。
 *  独立加密后存于 users/{username}/diary/YYYY/MM/DD/{batchId}.json，
 *  同一天的多个批次 = 多次进入系统的多份独立文件，互不覆盖。 */
export interface DiaryBatch {
  v: 1
  /** 批次（一次页面会话）的唯一 id；同一次会话跨天的消息在不同日文件夹下共用该 id */
  batchId: string
  messages: DiaryMessage[]
  createdAt: string
  updatedAt: string
}

export interface CredFields {
  ossAk: string
  ossSk: string
  bucket: string
  /** S3 兼容存储服务地址（完整域名或 URL，如 https://oss-cn-beijing.aliyuncs.com / cos.ap-shanghai.myqcloud.com / obs.cn-north-4.myhuaweicloud.com） */
  endpoint: string
  smtpUser: string
  smtpPass: string
  notifyEmail: string
}

/** 重复任务的“后备模板”：完成后不立刻生成下一次，而是先把下一次出现存成模板，
 *  等 dueDate（东八区 YYYY-MM-DD）当天再由前端物化为实际任务显示。
 *  所有属性与源任务一致，物化时仅日期按周期顺延。 */
export interface RepeatMaster {
  id: string
  projectId: string
  /** 源任务 id：完成重复任务时记录，用于编辑删除重复规则时追溯清理 */ 
  sourceTaskId: string
  /** 下次应生成（显示）的日期 YYYY-MM-DD（东八区） */
  dueDate: string
  /** 下一次出现的任务模板（pending，时间为该次出现的锚点时间） */
  template: Task
  createdAt: string
  updatedAt: string
}
