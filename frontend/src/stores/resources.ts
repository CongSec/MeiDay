import { defineStore } from 'pinia'
import { createOssClient } from '@/utils/oss'
import { logAttachmentDeletion, type AttachmentDeletionFile } from '@/utils/audit'
import { ossFileName } from '@/utils/attachments'
import { useAuthStore } from './auth'
import { useTasksStore } from './tasks'
import { useProjectsStore } from './projects'
import { UNCATEGORIZED, type Task } from '@/types'

/**
 * 时间胶囊 - 资源管理视图的数据层
 *
 * 展示范围（与时间胶囊「当前选中年份」一致）：
 *  - 已引用附件：选中年份胶囊任务（回收站 trash）引用的附件，信息取自任务元数据；
 *  - 孤儿附件：OSS 上存在、但未被任何「已加载任务」引用的附件（上传后未保存任务等），
 *    按对象 LastModified 年份过滤到所选年份。
 *
 * 「未引用」判定（用户确认：默认快判，不做全量校验）：
 *  - 引用集合 = 选中年份回收站 + 全部活跃任务 + 重复模板 中的附件元数据；
 *  - 活跃任务/重复模板的附件只进引用集合（避免误判为孤儿），不展示；
 *  - 不在引用集合中的 OSS 附件对象即孤儿。往年胶囊分片未加载，其中的引用无法感知
 *    （用户已接受该误判风险；删除只删二进制、不动任务 JSON）。
 *
 * 删除语义（用户确认）：只删 OSS 二进制，不清理任务 JSON 元数据，无确认弹窗。
 */

/** 资源视图单个附件条目 */
export interface ResourceItem {
  /** OSS 对象 key（users/{username}/attachments/{taskId}/{fileId}） */
  key: string
  taskId: string
  fileId: string
  name: string
  size: number
  /** MIME 类型：引用附件用任务元数据；孤儿先为空，内容嗅探后回填 */
  type: string
  /** 附件时间：引用附件用 uploadedAt，孤儿用 OSS LastModified */
  time: string
  /** OSS 对象 LastModified（ISO，孤儿按年份过滤用） */
  lastModified: string
  /** 是否孤儿（未被任何已加载任务/子任务/重复模板引用） */
  orphan: boolean
  /** 引用来源任务名（孤儿为空） */
  taskName: string
  /** 引用来源任务所属项目名（孤儿为空） */
  projectName: string
  /** 引用来源任务状态（completed / deleted / pending，孤儿为空） */
  taskStatus: string
  /** 引用来源任务更新时间（ISO，孤儿为空） */
  taskTime: string
  /** 孤儿是否已尝试嗅探类型（失败也会置 true，避免反复请求） */
  typeSniffed: boolean
}

/** 引用集合单条记录：来自任务/子任务/重复模板的附件元数据 */
interface RefRecord {
  name: string
  size: number
  type: string
  uploadedAt: string
  taskName: string
  projectName: string
  taskStatus: string
  taskTime: string
  /** 是否来自胶囊任务（选中年份回收站）：决定是否展示 */
  fromCapsule: boolean
}

/** 孤儿内容嗅探上限：超过该大小不做探测（部分 S3 实现可能忽略 Range 请求，会整文件下载） */
const SNIFF_MAX_SIZE = 1 * 1024 * 1024
const SNIFF_RANGE = 'bytes=0-31'
const SNIFF_CONCURRENCY = 4
/** 批量删除并发上限 */
const DELETE_CONCURRENCY = 6

/** 孤儿嗅探并发信号量（模块级：跨 store 实例共享） */
let sniffActive = 0
const sniffWaiters: (() => void)[] = []
async function sniffLock(): Promise<void> {
  while (sniffActive >= SNIFF_CONCURRENCY) {
    await new Promise<void>((resolve) => sniffWaiters.push(resolve))
  }
  sniffActive++
}
function sniffUnlock(): void {
  sniffActive--
  sniffWaiters.shift()?.()
}

/** 有界并发 map（与 tasks store 内 mapLimit 同款语义） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

function projectNameOf(id: string): string {
  if (!id || id === UNCATEGORIZED) return '无分类'
  const projects = useProjectsStore()
  return (
    projects.byId(id)?.name ??
    (projects.deletedProjects ?? []).find((x) => x.id === id)?.name ??
    `未知项目（${id.slice(0, 8)}…）`
  )
}

/** 大小写不敏感取响应头 */
function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && v != null) return String(v)
  }
  return undefined
}

/** 规范化 Content-Type：去参数、小写 */
function normalizeContentType(v: string | undefined): string {
  if (!v) return ''
  return v.split(';')[0].trim().toLowerCase()
}

/** 从文件头魔数识别位图类型（OSS 对象可能没存正确 Content-Type） */
function sniffMagicType(bytes: Uint8Array): string {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b.length >= 12) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  return ''
}

export const useResourcesStore = defineStore('resources', {
  state: () => ({
    /** 资源条目（按所选年份，引用胶囊附件 + 孤儿附件） */
    items: [] as ResourceItem[],
    /** 加载中 */
    loading: false,
    /** 已加载完成的年份（去重：同一年不重复全量扫描） */
    loadedYear: null as number | null,
    /** OSS 是否支持 list（false = 无列举权限，仅展示已引用附件） */
    listed: true,
    /** 加载失败信息（空串 = 正常） */
    error: '',
  }),
  actions: {
    /** 全量扫描并构建资源列表。force=true 强制重扫（刷新按钮）。 */
    async load(year: number, force = false): Promise<void> {
      if (this.loading) return
      if (!force && this.loadedYear === year && !this.error && this.items.length > 0) return
      const auth = useAuthStore()
      const tasks = useTasksStore()
      if (!auth.creds || !auth.username) {
        this.error = '缺少会话信息，请重新登录'
        this.loading = false
        return
      }
      this.loading = true
      this.error = ''
      this.loadedYear = year
      try {
        // 1) 从已加载任务数据构建引用集合（顺序：胶囊优先，活跃/重复模板兜底防误判孤儿）
        const refByKey = new Map<string, RefRecord>()
        const pushTask = (t: Task, fromCapsule: boolean) => {
          if (!t?.id) return
          const pname = projectNameOf(t.projectId)
          const base = {
            taskName: t.name || '未命名任务',
            projectName: pname,
            taskStatus: t.status || '',
            taskTime: t.updatedAt || '',
          }
          const pushAtt = (a?: { key?: string; name?: string; size?: number; type?: string; uploadedAt?: string }) => {
            if (!a?.key) return
            if (refByKey.has(a.key)) return
            refByKey.set(a.key, {
              name: a.name || '',
              size: a.size ?? 0,
              type: a.type || '',
              uploadedAt: a.uploadedAt || '',
              ...base,
              fromCapsule,
            })
          }
          for (const a of t.attachments ?? []) pushAtt(a)
          for (const sb of t.subtasks ?? []) {
            for (const a of sb.attachments ?? []) pushAtt(a)
          }
        }
        for (const arr of Object.values(tasks.trash)) for (const t of arr) pushTask(t, true)
        for (const arr of Object.values(tasks.tasks)) for (const t of arr) pushTask(t, false)
        for (const arr of Object.values(tasks.repeats)) {
          for (const m of arr) if (m?.template) pushTask(m.template, false)
        }

        // 2) 分页枚举 OSS attachments/ 前缀，分类构建条目
        const client = await createOssClient(auth.creds)
        const prefix = `users/${auth.username}/attachments/`
        const items: ResourceItem[] = []
        let listed = true
        let marker: string | undefined
        try {
          do {
            const query: Record<string, string | number> = { prefix, 'max-keys': 1000 }
            if (marker) query.marker = marker
            const res = await client.list(query as never, {} as never)
            for (const obj of res.objects ?? []) {
              const key = obj.name
              if (!key.startsWith(prefix)) continue
              const seg = key.split('/')
              const taskId = seg[seg.length - 2] ?? ''
              const fileId = seg[seg.length - 1] ?? ''
              if (!taskId || !fileId) continue
              const lastModified = obj.lastModified ? String(obj.lastModified) : ''
              const ref = refByKey.get(key)
              if (ref) {
                // 胶囊引用：展示；活跃任务/重复模板引用：只进引用集合不展示
                if (ref.fromCapsule) {
                  items.push({
                    key,
                    taskId,
                    fileId,
                    name: ref.name,
                    size: ref.size,
                    type: ref.type,
                    time: ref.uploadedAt || lastModified,
                    lastModified,
                    orphan: false,
                    taskName: ref.taskName,
                    projectName: ref.projectName,
                    taskStatus: ref.taskStatus,
                    taskTime: ref.taskTime,
                    typeSniffed: true,
                  })
                }
              } else {
                // 孤儿：按 LastModified 年份过滤到所选年份；时间缺失时归入当前年（避免跨年重复出现）
                const yearStr = String(year)
                const objYear = lastModified ? lastModified.slice(0, 4) : ''
                const include = objYear ? objYear === yearStr : yearStr === String(new Date().getFullYear())
                if (!include) continue
                items.push({
                  key,
                  taskId,
                  fileId,
                  name: fileId,
                  size: obj.size ?? 0,
                  type: '',
                  time: lastModified,
                  lastModified,
                  orphan: true,
                  taskName: '',
                  projectName: '',
                  taskStatus: '',
                  taskTime: '',
                  typeSniffed: false,
                })
              }
            }
            marker = res.isTruncated && res.nextMarker ? res.nextMarker : undefined
          } while (marker)
        } catch {
          // 无 list 权限：降级为仅展示胶囊引用附件（来自元数据，不核对二进制是否存在）
          listed = false
          for (const [key, ref] of refByKey) {
            if (!ref.fromCapsule) continue
            const seg = key.split('/')
            items.push({
              key,
              taskId: seg[seg.length - 2] ?? '',
              fileId: seg[seg.length - 1] ?? '',
              name: ref.name,
              size: ref.size,
              type: ref.type,
              time: ref.uploadedAt,
              lastModified: '',
              orphan: false,
              taskName: ref.taskName,
              projectName: ref.projectName,
              taskStatus: ref.taskStatus,
              taskTime: ref.taskTime,
              typeSniffed: true,
            })
          }
        }

        this.items = items
        this.listed = listed
      } catch (e) {
        this.error = (e as Error).message || '资源加载失败，请检查网络或 OSS 配置'
        this.items = []
      } finally {
        this.loading = false
      }
    },

    /** 刷新当前年份（保留已加载年份标记不变，强制重扫） */
    async refresh(): Promise<void> {
      if (this.loadedYear == null) return
      await this.load(this.loadedYear, true)
    },

    /** 孤儿内容类型嗅探：小文件用 Range 请求取 Content-Type / 魔数，结果写回条目。
     *  并发受限，失败静默（保留未识别状态）。 */
    async sniffOrphanType(item: ResourceItem): Promise<void> {
      if (!item.orphan || item.typeSniffed) return
      if (item.size > SNIFF_MAX_SIZE) return
      const auth = useAuthStore()
      if (!auth.creds) return
      await sniffLock()
      try {
        const client = await createOssClient(auth.creds)
        try {
          const res = await client.get(item.key, { headers: { Range: SNIFF_RANGE } })
          let type = normalizeContentType(headerOf(res.res.headers, 'content-type'))
          if (!type || type === 'application/octet-stream') {
            type = sniffMagicType(res.content)
          }
          if (type && type !== 'application/octet-stream') {
            item.type = type
            item.typeSniffed = true
          } else {
            // 探测过仍无法识别：标记已嗅探，避免下次重复请求
            item.typeSniffed = true
          }
        } catch {
          item.typeSniffed = true
        }
      } finally {
        sniffUnlock()
      }
    },

    /** 批量删除附件二进制（只删 OSS 对象，不动任务 JSON 元数据；无确认弹窗由调用方保证）。 */
    async deleteItems(list: ResourceItem[]): Promise<{ ok: number; failed: number }> {
      const auth = useAuthStore()
      if (!auth.creds || !list.length) return { ok: 0, failed: 0 }
      const client = await createOssClient(auth.creds)
      const results = await mapLimit(list, DELETE_CONCURRENCY, async (it) => {
        try {
          await client.delete(it.key)
          return true
        } catch {
          return false
        }
      })
      let ok = 0
      let failed = 0
      const deletedKeys = new Set<string>()
      // 删除日志汇总：只统计成功删除的条目
      const files: AttachmentDeletionFile[] = []
      let orphanCount = 0
      let totalSize = 0
      list.forEach((it, i) => {
        if (results[i]) {
          ok++
          deletedKeys.add(it.key)
          files.push({ name: ossFileName(it.key) || it.name, taskName: it.orphan ? '' : it.taskName })
          if (it.orphan) orphanCount++
          totalSize += it.size || 0
        } else {
          failed++
        }
      })
      if (deletedKeys.size) {
        this.items = this.items.filter((x) => !deletedKeys.has(x.key))
      }
      // 附件删除审计日志（统一行为名「删除附件」，来源=资源图）
      if (ok) {
        logAttachmentDeletion({ source: '资源图', count: ok, orphanCount, failed, totalSize, files })
      }
      return { ok, failed }
    },

    /** 退出资源视图/切换账号时清空内存态 */
    reset() {
      this.items = []
      this.loading = false
      this.loadedYear = null
      this.listed = true
      this.error = ''
    },
  },
})
