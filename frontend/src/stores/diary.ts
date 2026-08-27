import { defineStore } from 'pinia'
import type { OssClient } from '@/utils/oss'
import { useAuthStore } from './auth'
import { createOssClient } from '@/utils/oss'
import { clearDiarySession, getDiaryDek, isDiaryUnlocked, setDiaryDek } from '@/utils/diarySession'
import { createDiaryMeta, rewrapDiaryMeta, unwrapDiary } from '@/utils/diaryCrypto'
import {
  deleteDiaryBatch, deleteDiaryFile, deleteDiaryPeriod, exportDiary, getDiaryFileUrl, getDiaryMeta,
  importDiary, listDiaryDayBatches, listDiaryMonthDays, listDiaryPeriodMessages, loadDiaryBatch,
  putDiaryMeta, saveDiaryBatch, uploadDiaryFile,
} from '@/utils/diaryStorage'
import { releaseAllDiaryFileUrls, releaseDiaryFileUrl } from '@/utils/diaryBlobCache'
import {
  keepIdleLockAlive, setDiaryIdleClearHandler, startIdleLock, stopIdleLock,
} from '@/composables/useIdleLock'
import { maybeCompressImage } from '@/utils/diaryImageCompress'
import { nowIso, todayKey } from '@/utils/time'
import type { DiaryBatch, DiaryMessage } from '@/types'
import { logAudit, safeDetail } from '@/utils/audit'

/** 后台上传中的单个文件（用于界面并行展示进度，不阻塞其它发送） */
export interface DiaryUploadState {
  /** 上传项唯一 id */
  id: string
  /** 显示文件名 */
  name: string
  /** null=处理中（压缩/加密），数字=上传百分比 */
  percent: number | null
}

/** 消息按时间排序（同刻按 id 保证稳定） */
function sortMsgs(a: DiaryMessage, b: DiaryMessage): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

/** 当日写队列：同一日期文件的追加/删除/加载/导入串行化，避免并发覆盖（配合按天懒加载） */
const writeQueues = new Map<string, Promise<unknown>>()
function enqueueWrite<T>(dateKey: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(dateKey) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(task)
  writeQueues.set(dateKey, run)
  return run
}

/** 等待全部待写队列落盘完成（最多 timeoutMs 毫秒）。退出/锁定/重置/导入/删除前必须等待，
 *  否则排队中的 flush 会读到已清空的内存态，把云端会话批次误删 —— 这是数据丢失的重要根因。 */
async function flushAllPending(timeoutMs = 20000): Promise<void> {
  const pendings = Array.from(writeQueues.values())
  if (!pendings.length) return
  await Promise.race([
    Promise.all(pendings.map((p) => p.catch(() => {}))),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

/** 上传并发限制：避免多张图片同时上传互相抢带宽（移动端尤其明显），
 *  其余任务排队等待，界面仍实时显示全部进度。 */
const UPLOAD_CONCURRENCY = 2
class UploadSemaphore {
  private count: number
  private waiters: Array<() => void> = []

  constructor(limit: number) {
    this.count = limit
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.count++
  }
}
const uploadSemaphore = new UploadSemaphore(UPLOAD_CONCURRENCY)

let ossClient: OssClient | null = null

export const useDiaryStore = defineStore('diary', {
  state: () => ({
    unlocked: false,
    username: '',
    /** 当前会话批次 id：一次进入 → 退出/刷新 为一整批；跨天消息按所属日期分别写入对应文件夹 */
    sessionBatchId: '',
    /** 已解密天的展示消息（dateKey -> 合并后的消息列表），均按 createdAt 排序 */
    days: {} as Record<string, DiaryMessage[]>,
    /** 本次会话在当前天产生的消息（dateKey -> messages，是会话批次文件的落盘源） */
    sessionMsgs: {} as Record<string, DiaryMessage[]>,
    /** 已从云端加载过完整历史批次的日期（未加载的天不在其中） */
    loadedDates: {} as Record<string, boolean>,
    /** 有记录的日期集合（日历绿点） */
    knownDates: [] as string[],
    selectedDate: todayKey(),
    loadingDates: {} as Record<string, boolean>,
    /** 时间线版本：selectDate/resetTimeline 自增，通知聊天区重置滚动 */
    timelineVersion: 0,
    exporting: false,
    importing: false,
    deleting: false,
    /** 后台上传中的文件列表：多文件并行上传，界面据此展示进度；不阻塞文字发送 */
    uploads: [] as DiaryUploadState[],
    /** 只读回顾视图：按天分组的消息（dateKey -> messages） */
    reviewDays: [] as { dateKey: string; messages: DiaryMessage[] }[],
    reviewLoading: false,
  }),
  getters: {
    /** 已解密天的日期列表（升序） */
    dateKeys(state): string[] {
      return Object.keys(state.days).sort()
    },
    hasRecordOn: (state) => (dateKey: string) => state.knownDates.includes(dateKey),
  },
  actions: {
    /** 进入日记前初始化：返回 gate 模式（首次=setup，再次=enter，已解锁=unlocked） */
    async initSession(): Promise<'setup' | 'enter' | 'unlocked'> {
      const auth = useAuthStore()
      if (!auth.username || !auth.creds) throw new Error('请先在设置中配置 OSS 存储')
      if (isDiaryUnlocked() && ossClient) {
        // 每次进入都重置为空白时间线：不自动加载当天或任何历史日记；开启新的一批会话
        await this.resetTimeline()
        this.sessionBatchId = crypto.randomUUID()
        this.unlocked = true
        this.username = auth.username
        return 'unlocked'
      }
      ossClient = await createOssClient(auth.creds)
      this.username = auth.username
      const meta = await getDiaryMeta(ossClient, auth.username)
      return meta ? 'enter' : 'setup'
    },

    /** 首次设置密码 */
    async setupPassword(password: string): Promise<void> {
      if (!ossClient || !this.username) throw new Error('日记会话初始化失败')
      const { meta, dek } = await createDiaryMeta(password)
      await putDiaryMeta(ossClient, this.username, meta)
      this.applyUnlock(dek)
      logAudit('日记-设置密码')
    },

    /** 输入密码进入；密码错误返回 false */
    async enterPassword(password: string): Promise<boolean> {
      if (!ossClient || !this.username) throw new Error('日记会话初始化失败')
      const meta = await getDiaryMeta(ossClient, this.username)
      if (!meta) throw new Error('尚未设置日记密码')
      const dek = await unwrapDiary(meta, password)
      if (!dek) {
        logAudit('日记-进入失败')
        return false
      }
      this.applyUnlock(dek)
      logAudit('日记-进入成功')
      return true
    },

    /** 修改密码：校验旧密码后仅重包装 DEK */
    async changePassword(oldPw: string, newPw: string): Promise<void> {
      if (!ossClient || !this.username) throw new Error('日记会话初始化失败')
      const meta = await getDiaryMeta(ossClient, this.username)
      if (!meta) throw new Error('日记密码未初始化')
      const dek = getDiaryDek()
      if (!dek) throw new Error('日记会话已锁定')
      const check = await unwrapDiary(meta, oldPw)
      if (!check || check.length !== dek.length || !check.every((b, i) => b === dek[i])) {
        throw new Error('旧密码不正确')
      }
      const next = await rewrapDiaryMeta(meta, dek, newPw)
      await putDiaryMeta(ossClient, this.username, next)
      logAudit('日记-修改密码')
    },

    applyUnlock(dek: Uint8Array): void {
      setDiaryDek(dek)
      this.sessionBatchId = crypto.randomUUID()
      this.unlocked = true
      this.selectedDate = todayKey()
      startIdleLock()
      // 空闲到期兜底：即使离开日记页（停留在普通任务页）也要清空内存密钥与解密态
      setDiaryIdleClearHandler(() => {
        void this.lock()
      })
    },

    /** 每次进入日记前重置时间线：清空已解密天与导航状态，保证入口为空白页 */
    async resetTimeline(): Promise<void> {
      // 先等既有写队列落盘，避免清空内存态后排队中的 flush 把云端会话批次误删
      await flushAllPending(20000)
      this.days = {}
      this.sessionMsgs = {}
      this.loadedDates = {}
      this.knownDates = []
      this.loadingDates = {}
      this.selectedDate = todayKey()
      this.reviewDays = []
      this.timelineVersion++
    },

    /** 彻底清空会话：立即销毁密钥与解密态 */
    hardClear(): void {
      clearDiarySession()
      setDiaryIdleClearHandler(null)
      stopIdleLock()
      this.unlocked = false
      this.sessionBatchId = ''
      this.days = {}
      this.sessionMsgs = {}
      this.loadedDates = {}
      this.knownDates = []
      this.loadingDates = {}
      this.uploads = []
      this.reviewDays = []
      this.reviewLoading = false
      this.timelineVersion++
      releaseAllDiaryFileUrls()
    },

    /** 退出 / 空闲锁定 / 刷新后清空：先等后台写入（含在途上传落盘）再销毁会话 */
    async lock(): Promise<void> {
      // 文件上传为后台异步执行，写队列会在其上传完成后排队落盘；
      // 这里等待全部队列排空（含超时兜底）后再清空，避免丢数据
      await flushAllPending(20000)
      this.hardClear()
      logAudit('日记-退出')
    },

    /** 点击日历某天：只保留该天并懒加载，释放其余天的附件 Blob URL（清理旧日期内存） */
    async selectDate(dateKey: string): Promise<void> {
      const others = this.dateKeys.filter((k) => k !== dateKey)
      this.selectedDate = dateKey
      this.timelineVersion++
      await Promise.all(others.map((k) => this.unloadDay(k)))
      await this.loadDay(dateKey)
    },

    /** 懒加载某天：列出当天全部批次文件 → 解密合并 → 与本会话消息合并 */
    async loadDay(dateKey: string): Promise<void> {
      if (this.loadedDates[dateKey] || this.loadingDates[dateKey]) return
      this.loadingDates[dateKey] = true
      try {
        await enqueueWrite(dateKey, async () => {
          const dek = getDiaryDek()
          if (!ossClient || !this.username || !dek) return
          const batches = await listDiaryDayBatches(ossClient, this.username, dek, dateKey)
          const byId = new Map<string, DiaryMessage>()
          for (const b of batches) for (const m of b.messages ?? []) byId.set(m.id, m)
          for (const m of this.sessionMsgs[dateKey] ?? []) byId.set(m.id, m)
          const msgs = Array.from(byId.values()).sort(sortMsgs)
          this.days[dateKey] = msgs
          this.loadedDates[dateKey] = true
          if (msgs.length) this.addKnownDate(dateKey)
        })
      } finally {
        this.loadingDates[dateKey] = false
      }
    },

    /** 刷新某月的有记录日期（日历绿点，只取 key 不解密）；先清当月旧记录再重列，避免被删除的天残留绿点 */
    async refreshMonth(y: number, m: number): Promise<void> {
      if (!ossClient || !this.username) return
      const prefix = `${String(y)}-${String(m).padStart(2, '0')}`
      this.knownDates = this.knownDates.filter((d) => !d.startsWith(prefix))
      const days = await listDiaryMonthDays(ossClient, this.username, String(y), String(m))
      for (const d of days) this.addKnownDate(d)
    },

    /** 卸载某天：等该天待写队列完成后释放其附件 Blob URL 并从内存移除（数据已落盘，可随时重载） */
    async unloadDay(dateKey: string): Promise<void> {
      if (dateKey === this.selectedDate) return
      await enqueueWrite(dateKey, async () => {
        const msgs = this.days[dateKey]
        if (msgs) for (const m of msgs) if (m.file) releaseDiaryFileUrl(m.file.fileId)
        delete this.days[dateKey]
        delete this.loadedDates[dateKey]
        delete this.loadingDates[dateKey]
      })
    },

    /** 发送文本：仅追加到当前选中天 */
    async sendText(text: string): Promise<void> {
      const content = text.trim()
      if (!content) return
      const dateKey = this.selectedDate
      const msg: DiaryMessage = {
        id: crypto.randomUUID(),
        type: 'text',
        text: content,
        createdAt: nowIso(),
        appended: dateKey !== todayKey(),
      }
      await this.appendMessage(dateKey, msg)
      logAudit('日记-发送文本')
    },

    /** 后台上传文件/语音：立即加入上传列表返回，不阻塞界面；
     *  多文件受限并发加密/上传（避免抢带宽），各自完成后追加消息并按写队列落盘。
     *  超大图片会自动压缩后再上传，显著加快移动端上传速度。 */
    async sendFile(
      file: File,
      type: 'file' | 'audio' = 'file',
      opts?: { duration?: number; name?: string },
    ): Promise<void> {
      const dateKey = this.selectedDate
      const dek = getDiaryDek()
      if (!ossClient || !this.username || !dek) throw new Error('日记会话已锁定')
      const fileId = crypto.randomUUID()
      const displayName = opts?.name ?? file.name
      const state: DiaryUploadState = { id: fileId, name: displayName, percent: null }
      this.uploads.push(state)
      await uploadSemaphore.acquire()
      try {
        // 大图自动压缩（有损 JPEG，长边 ≤1920），体积常可缩小 5~10 倍
        let uploadFile: File = file
        if (type === 'file' && file.type.startsWith('image/')) {
          uploadFile = await maybeCompressImage(file)
          const cur = this.uploads.find((u) => u.id === fileId)
          if (cur) cur.name = uploadFile.name
        }
        const data = new Uint8Array(await uploadFile.arrayBuffer())
        await uploadDiaryFile(ossClient, this.username, dek, fileId, data, (p) => {
          const cur = this.uploads.find((u) => u.id === fileId)
          if (cur) cur.percent = Math.round(p * 100)
          keepIdleLockAlive()
        })
        const msg: DiaryMessage = {
          id: crypto.randomUUID(),
          type,
          file: {
            fileId,
            name: uploadFile.name,
            size: uploadFile.size,
            mime: uploadFile.type || 'application/octet-stream',
            ...(opts?.duration !== undefined ? { duration: opts.duration } : {}),
          },
          createdAt: nowIso(),
          appended: dateKey !== todayKey(),
        }
        await this.appendMessage(dateKey, msg)
        logAudit('日记-发送文件')
      } finally {
        uploadSemaphore.release()
        this.uploads = this.uploads.filter((u) => u.id !== fileId)
      }
    },

    /** 追加消息并排队落盘（同一天串行写入） */
    async appendMessage(dateKey: string, msg: DiaryMessage): Promise<void> {
      if (!this.unlocked || !getDiaryDek()) throw new Error('日记会话已锁定')
      if (!this.sessionMsgs[dateKey]) this.sessionMsgs[dateKey] = []
      this.sessionMsgs[dateKey].push(msg)
      // 重建展示列表：已有展示消息 ∪ 本会话消息（新消息 id 与云端历史不冲突）
      const byId = new Map<string, DiaryMessage>()
      for (const m of this.days[dateKey] ?? []) byId.set(m.id, m)
      for (const m of this.sessionMsgs[dateKey]) byId.set(m.id, m)
      this.days[dateKey] = Array.from(byId.values()).sort(sortMsgs)
      this.addKnownDate(dateKey)
      // 本天已有内容，标记为已加载：聊天区才能从「空状态」切换到消息时间线渲染
      this.loadedDates[dateKey] = true
      this.selectedDate = dateKey
      await enqueueWrite(dateKey, () => this.flushSessionBatch(dateKey))
    },

    /** 把当前会话在某天的消息加密落盘（合并云端同批次已有消息，避免覆盖丢失）；
     *  空批次则删除该天该批次文件。 */
    async flushSessionBatch(dateKey: string): Promise<void> {
      if (!ossClient || !this.username || !getDiaryDek()) return
      const batchId = this.sessionBatchId
      if (!batchId) return
      const existing = await loadDiaryBatch(ossClient, this.username, getDiaryDek()!, dateKey, batchId)
      const byId = new Map<string, DiaryMessage>()
      for (const m of existing?.messages ?? []) byId.set(m.id, m)
      for (const m of this.sessionMsgs[dateKey] ?? []) byId.set(m.id, m)
      const messages = Array.from(byId.values()).sort(sortMsgs)
      if (!messages.length) {
        await deleteDiaryBatch(ossClient, this.username, dateKey, batchId)
        return
      }
      const batch: DiaryBatch = {
        v: 1,
        batchId,
        messages,
        createdAt: existing?.createdAt ?? messages[0].createdAt,
        updatedAt: nowIso(),
      }
      await saveDiaryBatch(ossClient, this.username, getDiaryDek()!, dateKey, batch)
    },

    /** 删除单条消息（含附件密文清理）；历史批次的删除会重写对应批次文件 */
    async deleteMessage(dateKey: string, msgId: string): Promise<void> {
      if (!ossClient || !this.username || !getDiaryDek()) return
      const arr = this.days[dateKey]
      if (!arr) return
      const msg = arr.find((m) => m.id === msgId)
      if (!msg) return
      if (msg.file) {
        await deleteDiaryFile(ossClient, this.username, msg.file.fileId)
        releaseDiaryFileUrl(msg.file.fileId)
      }
      const sessionList = this.sessionMsgs[dateKey]
      const inSession = sessionList?.some((m) => m.id === msgId) ?? false
      if (inSession) {
        this.sessionMsgs[dateKey] = sessionList!.filter((m) => m.id !== msgId)
      }
      await enqueueWrite(dateKey, async () => {
        if (!inSession) {
          // 属于历史批次：找到包含它的批次文件，移除该消息后重写（空则删除文件）
          const batches = await listDiaryDayBatches(ossClient!, this.username, getDiaryDek()!, dateKey)
          for (const b of batches) {
            if (b.batchId === this.sessionBatchId) continue // 会话批次由 sessionMsgs 负责
            if (b.messages.some((m) => m.id === msgId)) {
              const rest = b.messages.filter((m) => m.id !== msgId)
              if (rest.length) {
                await saveDiaryBatch(ossClient!, this.username, getDiaryDek()!, dateKey, {
                  ...b,
                  messages: rest,
                  updatedAt: nowIso(),
                })
              } else {
                await deleteDiaryBatch(ossClient!, this.username, dateKey, b.batchId)
              }
              break
            }
          }
        }
        await this.flushSessionBatch(dateKey)
        // 重建展示列表并维护日历绿点
        const byId = new Map<string, DiaryMessage>()
        for (const m of this.days[dateKey] ?? []) if (m.id !== msgId) byId.set(m.id, m)
        this.days[dateKey] = Array.from(byId.values()).sort(sortMsgs)
        if (!this.days[dateKey].length) this.removeKnownDate(dateKey)
      })
      logAudit('日记-删除消息')
    },

    /** 按月或按年导出（zip，保留 OSS 原始结构，全密文；导出密码用于包装源 DEK 供跨账号导入） */
    async exportPeriod(y: number, m: number | undefined, exportPassword: string): Promise<{ count: number; name: string }> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      this.exporting = true
      try {
        const { blob, name, count } = await exportDiary(
          ossClient,
          this.username,
          getDiaryDek()!,
          String(y),
          m !== undefined ? String(m) : undefined,
          exportPassword,
        )
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 5000)
        logAudit('日记-导出', safeDetail(`共 ${count} 个加密文件`))
        return { count, name }
      } finally {
        this.exporting = false
      }
    },

    /** 导入（zip，逐条合并；先解密验证再写回）。
     *  跨账号包（含 dek.json）需提供导出密码，导入时会重加密成当前账号 DEK。 */
    async importPeriod(file: File, exportPassword?: string): Promise<number> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      this.importing = true
      try {
        // 先等既有写队列落盘，避免导入写回与排队中的 flush 互相干扰
        await flushAllPending(20000)
        const count = await importDiary(ossClient, this.username, getDiaryDek()!, file, exportPassword)
        // 合并后重建内存缓存（保留本会话消息，loadDay 会再合并），保证日历/时间线一致
        this.days = {}
        this.loadedDates = {}
        this.knownDates = []
        this.reviewDays = []
        await this.refreshMonth(Number(this.selectedDate.slice(0, 4)), Number(this.selectedDate.slice(5, 7)))
        await this.loadDay(this.selectedDate)
        logAudit('日记-导入', safeDetail(`共 ${count} 条密文记录`))
        return count
      } finally {
        this.importing = false
      }
    },

    /** 按月或按年删除（含附件密文；范围外数据不动） */
    async deletePeriod(y: number, m?: number): Promise<{ days: number; files: number }> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      this.deleting = true
      try {
        await flushAllPending(20000)
        const prefix = `${y}${m !== undefined ? '-' + String(m).padStart(2, '0') : ''}`
        // 先释放内存中目标日期的附件 URL 并从时间线移除
        for (const k of Object.keys(this.days)) {
          if (k.startsWith(prefix)) {
            const msgs = this.days[k]
            if (msgs) for (const msg of msgs) if (msg.file) releaseDiaryFileUrl(msg.file.fileId)
            delete this.days[k]
            delete this.loadedDates[k]
          }
        }
        // 目标范围内的本会话消息同步清空（云端该范围已整体删除）
        for (const k of Object.keys(this.sessionMsgs)) {
          if (k.startsWith(prefix)) delete this.sessionMsgs[k]
        }
        this.reviewDays = this.reviewDays.filter((d) => !d.dateKey.startsWith(prefix))
        this.knownDates = this.knownDates.filter((d) => !d.startsWith(prefix))
        const result = await deleteDiaryPeriod(ossClient, this.username, getDiaryDek()!, y, m)
        await this.refreshMonth(Number(this.selectedDate.slice(0, 4)), Number(this.selectedDate.slice(5, 7)))
        if (this.days[this.selectedDate] === undefined) await this.loadDay(this.selectedDate)
        this.timelineVersion++
        logAudit('日记-删除', safeDetail(`共 ${result.days} 天、${result.files} 个附件`))
        return result
      } finally {
        this.deleting = false
      }
    },

    /** 解密文件的 Blob URL（缓存；退出时统一释放） */
    async fileUrl(fileId: string, mime: string): Promise<string> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      return getDiaryFileUrl(ossClient, this.username, getDiaryDek()!, fileId, mime)
    },

    /** 回顾：加载 [startKey, endKey] 时间段内全部消息（只解密元数据，附件按需懒加载） */
    async loadReview(startKey: string, endKey: string): Promise<{ days: number; messages: number }> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      await this.closeReview()
      this.reviewLoading = true
      try {
        await flushAllPending(20000)
        const days = await listDiaryPeriodMessages(ossClient, this.username, getDiaryDek()!, startKey, endKey)
        this.reviewDays = days
        logAudit('日记-回顾', safeDetail(`共 ${days.length} 天 / ${days.reduce((n, d) => n + d.messages.length, 0)} 条记录`))
        return {
          days: days.length,
          messages: days.reduce((n, d) => n + d.messages.length, 0),
        }
      } finally {
        this.reviewLoading = false
      }
    },

    /** 关闭回顾：释放本次回顾已下载的附件 URL（仍被当前主时间线引用的除外），清空回顾数据 */
    async closeReview(): Promise<void> {
      const active = new Set<string>()
      for (const k of Object.keys(this.days)) {
        for (const m of this.days[k] ?? []) if (m.file) active.add(m.file.fileId)
      }
      for (const d of this.reviewDays) {
        for (const m of d.messages) {
          if (m.file && !active.has(m.file.fileId)) releaseDiaryFileUrl(m.file.fileId)
        }
      }
      this.reviewDays = []
      logAudit('日记-回顾关闭')
    },

    addKnownDate(dateKey: string): void {
      if (!this.knownDates.includes(dateKey)) this.knownDates.push(dateKey)
    },
    removeKnownDate(dateKey: string): void {
      this.knownDates = this.knownDates.filter((d) => d !== dateKey)
    },
  },
})
