import { defineStore } from 'pinia'
import type OSS from 'ali-oss'
import { useAuthStore } from './auth'
import { createOssClient } from '@/utils/oss'
import { clearDiarySession, getDiaryDek, isDiaryUnlocked, setDiaryDek } from '@/utils/diarySession'
import { createDiaryMeta, rewrapDiaryMeta, unwrapDiary } from '@/utils/diaryCrypto'
import {
  deleteDiaryDay, deleteDiaryFile, exportDiary, getDiaryFileUrl, getDiaryMeta, importDiary,
  listDiaryMonthDays, loadDiaryDay, putDiaryMeta, saveDiaryDay, uploadDiaryFile,
} from '@/utils/diaryStorage'
import { releaseAllDiaryFileUrls, releaseDiaryFileUrl } from '@/utils/diaryBlobCache'
import { setDiaryIdleClearHandler, startIdleLock, stopIdleLock } from '@/composables/useIdleLock'
import { addDaysKey, nowIso, todayKey } from '@/utils/time'
import type { DiaryDay, DiaryMessage } from '@/types'

/** 当日写队列：同一日期文件的追加/删除/导入串行化，避免并发覆盖（配合懒加载逐日读写） */
const writeQueues = new Map<string, Promise<unknown>>()
function enqueueWrite<T>(dateKey: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(dateKey) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(task)
  writeQueues.set(dateKey, run)
  return run
}

let ossClient: OSS | null = null

export const useDiaryStore = defineStore('diary', {
  state: () => ({
    unlocked: false,
    username: '',
    /** 已解密的天（dateKey -> 消息列表），全部为内存态 */
    days: {} as Record<string, DiaryMessage[]>,
    /** 有记录的日期集合（日历绿点 / 上一天下一天导航） */
    knownDates: [] as string[],
    selectedDate: todayKey(),
    loadingDates: {} as Record<string, boolean>,
    /** 已列出过的月份（YYYY-M），避免重复 OSS list */
    listedMonths: [] as string[],
    sending: false,
    exporting: false,
    importing: false,
  }),
  getters: {
    /** 时间线：已加载日期的升序列表 */
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
    },

    /** 输入密码进入；密码错误返回 false */
    async enterPassword(password: string): Promise<boolean> {
      if (!ossClient || !this.username) throw new Error('日记会话初始化失败')
      const meta = await getDiaryMeta(ossClient, this.username)
      if (!meta) throw new Error('尚未设置日记密码')
      const dek = await unwrapDiary(meta, password)
      if (!dek) return false
      this.applyUnlock(dek)
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
    },

    applyUnlock(dek: Uint8Array): void {
      setDiaryDek(dek)
      this.unlocked = true
      this.selectedDate = todayKey()
      startIdleLock()
      // 空闲到期兜底：即使离开日记页（停留在普通任务页）也要清空内存密钥与解密态
      setDiaryIdleClearHandler(() => {
        clearDiarySession()
        this.unlocked = false
        this.days = {}
        this.knownDates = []
        this.listedMonths = []
        this.loadingDates = {}
        releaseAllDiaryFileUrls()
      })
    },

    /** 退出 / 空闲锁定 / 刷新后清空：立即销毁密钥与解密态 */
    lock(): void {
      clearDiarySession()
      setDiaryIdleClearHandler(null)
      stopIdleLock()
      this.unlocked = false
      this.days = {}
      this.knownDates = []
      this.loadingDates = {}
      this.listedMonths = []
      this.sending = false
      releaseAllDiaryFileUrls()
    },

    /** 点击日历某天：仅懒加载并解密该天；加载完成后再切 selectedDate，保证聊天时间线能滚动定位 */
    async selectDate(dateKey: string): Promise<void> {
      await this.loadDay(dateKey)
      this.selectedDate = dateKey
    },

    async loadDay(dateKey: string): Promise<void> {
      if (this.days[dateKey] !== undefined || this.loadingDates[dateKey]) return
      this.loadingDates[dateKey] = true
      try {
        await enqueueWrite(dateKey, async () => {
          const dek = getDiaryDek()
          if (!ossClient || !this.username || !dek) return
          const day = await loadDiaryDay(ossClient, this.username, dek, dateKey)
          if (day && day.messages.length) {
            this.days[dateKey] = day.messages
            this.addKnownDate(dateKey)
          } else {
            this.days[dateKey] = []
          }
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

    /** 确保某日期所在月份已被 list 进 knownDates（跨月导航时按需列出） */
    async ensureMonthListed(dateKey: string): Promise<void> {
      const [y, m] = dateKey.split('-').map(Number)
      const key = `${y}-${m}`
      if (this.listedMonths.includes(key)) return
      await this.refreshMonth(y, m)
      this.listedMonths.push(key)
    },

    /** 从 fromKey 向 dir 方向找最近的有记录日期（自动列出跨过的月份）；找不到返回 null */
    async findRecordedDate(fromKey: string, dir: 1 | -1, maxSteps = 90): Promise<string | null> {
      let cur = fromKey
      for (let i = 0; i < maxSteps; i++) {
        cur = addDaysKey(cur, dir)
        await this.ensureMonthListed(cur)
        if (this.hasRecordOn(cur)) return cur
      }
      return null
    },

    /** 卸载某天：等该天待写队列完成后释放其附件 Blob URL 并从内存移除（数据已落盘，可随时重载） */
    async unloadDay(dateKey: string): Promise<void> {
      if (dateKey === this.selectedDate) return
      await enqueueWrite(dateKey, async () => {
        const msgs = this.days[dateKey]
        if (msgs) for (const m of msgs) if (m.file) releaseDiaryFileUrl(m.file.fileId)
        delete this.days[dateKey]
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
    },

    /** 发送文件/语音：加密直传附件密文后追加消息 */
    async sendFile(
      file: File,
      type: 'file' | 'audio' = 'file',
      opts?: { duration?: number; name?: string },
    ): Promise<void> {
      const dateKey = this.selectedDate
      const dek = getDiaryDek()
      if (!ossClient || !this.username || !dek) throw new Error('日记会话已锁定')
      const fileId = crypto.randomUUID()
      this.sending = true
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        await uploadDiaryFile(ossClient, this.username, dek, fileId, data)
        const msg: DiaryMessage = {
          id: crypto.randomUUID(),
          type,
          file: {
            fileId,
            name: opts?.name ?? file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            ...(opts?.duration !== undefined ? { duration: opts.duration } : {}),
          },
          createdAt: nowIso(),
          appended: dateKey !== todayKey(),
        }
        await this.appendMessage(dateKey, msg)
      } finally {
        this.sending = false
      }
    },

    /** 追加消息并排队落盘（同一天串行写入） */
    async appendMessage(dateKey: string, msg: DiaryMessage): Promise<void> {
      if (!this.days[dateKey]) this.days[dateKey] = []
      this.days[dateKey].push(msg)
      this.addKnownDate(dateKey)
      this.selectedDate = dateKey
      await enqueueWrite(dateKey, () => this.flushDay(dateKey))
    },

    /** 把某天内存态加密落盘；空则删除当天文件 */
    async flushDay(dateKey: string): Promise<void> {
      if (!ossClient || !this.username || !getDiaryDek()) return
      const messages = this.days[dateKey] ?? []
      if (!messages.length) {
        await deleteDiaryDay(ossClient, this.username, dateKey)
        this.removeKnownDate(dateKey)
        return
      }
      const day: DiaryDay = { v: 1, messages, updatedAt: nowIso() }
      await saveDiaryDay(ossClient, this.username, getDiaryDek()!, dateKey, day)
    },

    /** 删除单条消息（含附件密文清理） */
    async deleteMessage(dateKey: string, msgId: string): Promise<void> {
      if (!ossClient || !this.username) return
      const arr = this.days[dateKey]
      if (!arr) return
      const idx = arr.findIndex((m) => m.id === msgId)
      if (idx < 0) return
      const [msg] = arr.splice(idx, 1)
      if (msg.file) {
        await deleteDiaryFile(ossClient, this.username, msg.file.fileId)
        releaseDiaryFileUrl(msg.file.fileId)
      }
      await enqueueWrite(dateKey, () => this.flushDay(dateKey))
    },

    /** 上一天/下一天：跳到相邻有记录的日期（无则返回 null） */
    nextRecordDate(dir: 1 | -1): string | null {
      const sorted = [...this.knownDates].sort()
      if (dir > 0) return sorted.find((d) => d > this.selectedDate) ?? null
      return [...sorted].reverse().find((d) => d < this.selectedDate) ?? null
    },

    /** 按月或按年导出（zip，保留 OSS 原始结构，全密文） */
    async exportPeriod(y: number, m?: number): Promise<{ count: number; name: string }> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      this.exporting = true
      try {
        const { blob, name, count } = await exportDiary(
          ossClient,
          this.username,
          getDiaryDek()!,
          String(y),
          m !== undefined ? String(m) : undefined,
        )
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 5000)
        return { count, name }
      } finally {
        this.exporting = false
      }
    },

    /** 导入（zip，逐条合并；先解密验证再写回） */
    async importPeriod(file: File): Promise<number> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      this.importing = true
      try {
        const count = await importDiary(ossClient, this.username, getDiaryDek()!, file)
        // 合并后重建内存缓存，保证日历/时间线一致
        this.days = {}
        this.knownDates = []
        this.listedMonths = []
        await this.refreshMonth(Number(this.selectedDate.slice(0, 4)), Number(this.selectedDate.slice(5, 7)))
        await this.loadDay(this.selectedDate)
        return count
      } finally {
        this.importing = false
      }
    },

    /** 解密文件的 Blob URL（缓存；退出时统一释放） */
    async fileUrl(fileId: string, mime: string): Promise<string> {
      if (!ossClient || !this.username || !getDiaryDek()) throw new Error('日记会话已锁定')
      return getDiaryFileUrl(ossClient, this.username, getDiaryDek()!, fileId, mime)
    },

    addKnownDate(dateKey: string): void {
      if (!this.knownDates.includes(dateKey)) this.knownDates.push(dateKey)
    },
    removeKnownDate(dateKey: string): void {
      this.knownDates = this.knownDates.filter((d) => d !== dateKey)
    },
  },
})
