import { deleteAttachments, uploadAttachment } from './attachments'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import type { AttachmentMeta, CredFields } from '@/types'

/**
 * 附件后台上传队列
 *
 * 需求背景：保存任务不再等待附件上传完成。用户在弹窗中选中的文件立即进入本队列上传；
 * 点“保存”时若仍有未传完的文件，任务照常保存，队列在后台继续上传，全部成功后把附件
 * meta 写回任务/子任务 JSON，并统一提示“文件上传成功，任务保存成功”；单个失败则提示
 * 失败并清理已产生的孤文件。
 *
 * 会话（uid）：一次打开任务弹窗 = 一个会话。
 *  - 选文件 → enqueueUploads()（未提交：上传完成仅用于弹窗展示，不写回任务）；
 *  - 保存成功 → commitUploads()（此后完成的附件写回任务 JSON，全部完成统一 toast）；
 *  - 取消 / 保存失败 → cancelSessionUploads() / cancelUploadByMetaId()（已完成的孤文件
 *    立即删除，进行中的完成后删除，不再写回任务）。
 */

export interface BackgroundUploadItem {
  /** 上传项唯一 id（弹窗内每个文件一个） */
  id: string
  /** 弹窗会话标识 */
  uid: string
  creds: CredFields
  username: string
  file: File
  /** 附件归属任务 id（子任务归父任务 id） */
  taskId: string
  /** 非空表示附件属于子任务 */
  subtaskId: string | null
  projectId: string
}

export interface BackgroundUploadState extends BackgroundUploadItem {
  state: 'pending' | 'uploading' | 'done' | 'failed' | 'cancelled'
  /** 上传成功后生成的附件元数据（未成功时为 undefined） */
  meta?: AttachmentMeta
  error?: string
  /** 已提交保存（保存成功后置 true）：完成的附件要写回任务 JSON */
  committed: boolean
  /** 已“收尾”：已写回任务 JSON / 已随保存的任务 JSON 落盘 / 已失败或取消 */
  settled: boolean
  /** 写回任务 JSON 的 in-flight 标记（避免重复写回） */
  settling: boolean
  /** 上传被取消（保存前删除附件 / 取消弹窗 / 保存失败）：完成后删除孤文件 */
  cancelled: boolean
  /** 失败提示已弹出（避免重复弹） */
  failureToasted: boolean
}

export interface GlobalUploadInfo {
  /** 正在排队或上传中的文件数 */
  active: number
  /** 当前正在上传的文件名（无则省略） */
  currentName?: string
}

const items = new Map<string, BackgroundUploadState>()
const byUid = new Map<string, Set<string>>()
const listeners = new Map<string, Set<(item: BackgroundUploadState) => void>>()
let processing = false

const globalListeners = new Set<(info: GlobalUploadInfo) => void>()

/** 全局后台上传状态：跨会话汇总，供全局提示组件订阅 */
export function getGlobalUploadInfo(): GlobalUploadInfo {
  let active = 0
  let currentName: string | undefined
  for (const item of items.values()) {
    if (item.state === 'pending' || item.state === 'uploading') {
      active++
      if (item.state === 'uploading' && currentName === undefined) currentName = item.file.name
    }
  }
  return { active, currentName }
}

export function subscribeGlobal(fn: (info: GlobalUploadInfo) => void): () => void {
  globalListeners.add(fn)
  return () => {
    globalListeners.delete(fn)
  }
}

/** 状态变化后通知全局订阅者（提示组件据此显隐/刷新） */
function emitGlobal() {
  const info = getGlobalUploadInfo()
  for (const fn of globalListeners) fn(info)
}

function notify(uid: string, item: BackgroundUploadState) {
  const set = listeners.get(uid)
  if (set) for (const fn of set) fn(item)
}
  emitGlobal()

function nextPending(): BackgroundUploadState | undefined {
  for (const item of items.values()) {
    if (item.state === 'pending' && !item.cancelled) return item
  }
  return undefined
}

/** 会话内已无“未收尾”项时清掉内存（避免残留；保存中/弹窗打开中的会话保留） */
function cleanupSessionIfEmpty(uid: string) {
  const ids = byUid.get(uid)
  if (!ids || !ids.size) {
    byUid.delete(uid)
    listeners.delete(uid)
    emitGlobal()
    return
  }
  const all = [...ids].map((id) => items.get(id)).filter((i): i is BackgroundUploadState => !!i)
  const terminal = (i: BackgroundUploadState) =>
    i.state === 'cancelled' ||
    i.state === 'failed' ||
    (i.state === 'done' && i.settled)
  if (all.every(terminal)) {
    for (const id of ids) items.delete(id)
    byUid.delete(uid)
    listeners.delete(uid)
  }
  emitGlobal()
}

/** 单个附件失败的统一处理：提示 + 删除已产生的孤文件（每个只弹一次） */
function toastFailure(item: BackgroundUploadState) {
  if (item.failureToasted) return
  item.failureToasted = true
  useUiStore().toast(
    `附件「${item.file.name}」上传失败${item.error ? `：${item.error}` : ''}`,
    'error',
  )
  if (item.meta) void deleteAttachments(item.creds, [item.meta])
}

/** 已提交保存的上传完成：把附件 meta 写回任务/子任务 JSON；任务不存在则删孤文件并提示 */
async function settleItem(item: BackgroundUploadState) {
  if (item.settled || item.settling || !item.meta) return
  item.settling = true
  try {
    const ok = await useTasksStore().attachBackgroundAttachment(
      item.taskId,
      item.subtaskId,
      item.meta,
      item.projectId,
    )
    item.settled = true
    if (!ok) {
      item.state = 'failed'
      item.error = '任务不存在或已删除，附件未写入'
      toastFailure(item)
    }
  } catch (e) {
    item.settled = true
    item.state = 'failed'
    item.error = (e as Error).message || '附件写回任务失败'
    toastFailure(item)
  } finally {
    item.settling = false
  }
  notify(item.uid, item)
  cleanupSessionIfEmpty(item.uid)
  maybeSummarize(item.uid)
}

/** 会话内全部已提交项收尾后：全部成功统一提示“文件上传成功，任务保存成功”；失败已逐个提示 */
function maybeSummarize(uid: string) {
  const ids = byUid.get(uid)
  if (!ids?.size) return
  const all = [...ids].map((id) => items.get(id)).filter((i): i is BackgroundUploadState => !!i)
  const committed = all.filter((i) => i.committed)
  if (!committed.length) return
  const terminal = (i: BackgroundUploadState) =>
    i.state === 'cancelled' || i.state === 'failed' || (i.state === 'done' && i.settled)
  if (!committed.every(terminal)) return
  if (committed.every((i) => i.state === 'done')) {
    useUiStore().toast('文件上传成功，任务保存成功')
  }
  for (const id of ids) items.delete(id)
  byUid.delete(uid)
  listeners.delete(uid)
  emitGlobal()
}

/** 入队一批附件上传（立即后台开始，串行逐个上传） */
export function enqueueUploads(list: BackgroundUploadItem[]) {
  let added = false
  for (const it of list) {
    if (items.has(it.id)) continue
    items.set(it.id, {
      ...it,
      state: 'pending',
      committed: false,
      settled: false,
      settling: false,
      cancelled: false,
      failureToasted: false,
    })
    const ids = byUid.get(it.uid) ?? new Set<string>()
    ids.add(it.id)
    byUid.set(it.uid, ids)
    added = true
  }
  if (added) {
    void runQueue()
    emitGlobal()
  }
}

/** 保存成功后提交会话：此后完成的附件写回任务 JSON；已随任务 JSON 落盘的（提交前已完成）无需再写回 */
export function commitUploads(
  uid: string,
  opts: { projectId: string; savedMetaIds: Set<string> },
) {
  const ids = byUid.get(uid)
  if (!ids?.size) return
  for (const id of ids) {
    const item = items.get(id)
    if (!item || item.cancelled) continue
    item.projectId = opts.projectId
    item.committed = true
    if (item.state === 'failed') {
      toastFailure(item)
      continue
    }
    if (item.meta && opts.savedMetaIds.has(item.meta.id)) {
      // 上传已完成且已随任务 JSON 保存：无需再写回
      item.settled = true
      continue
    }
    if (item.state === 'done') void settleItem(item)
  }
  maybeSummarize(uid)
}

/** 取消会话中的部分上传（仅未提交保存的生效）：已完成的删孤文件，进行中的完成后删除 */
export function cancelUploads(uid: string, ids: Iterable<string>) {
  for (const id of ids) {
    const item = items.get(id)
    if (!item || item.committed) continue
    item.cancelled = true
    if (item.state === 'pending') {
      items.delete(id)
      byUid.get(uid)?.delete(id)
      continue
    }
    if (item.meta) void deleteAttachments(item.creds, [item.meta])
    if (item.state === 'done') {
      item.state = 'cancelled'
      items.delete(id)
      byUid.get(uid)?.delete(id)
    }
    // uploading：无法中断，保留到上传结束后在 runQueue 中删孤文件
    notify(item.uid, item)
  }
  cleanupSessionIfEmpty(uid)
}

/** 取消整个会话的全部上传（取消弹窗 / 保存失败时清理本次未保存的孤文件） */
export function cancelSessionUploads(uid: string) {
  const ids = byUid.get(uid)
  if (!ids?.size) return
  cancelUploads(uid, [...ids])
}

/** 按附件 meta id 取消对应上传（弹窗里删除某个已上传附件时） */
export function cancelUploadByMetaId(uid: string, metaId: string) {
  const ids = byUid.get(uid)
  if (!ids?.size) return
  for (const id of ids) {
    const item = items.get(id)
    if (item && !item.committed && item.meta?.id === metaId) {
      cancelUploads(uid, [id])
      return
    }
  }
}

/** 会话当前还有多少个未完成的上传（弹窗据此显示“上传中…”） */
export function getActiveUploadCount(uid: string): number {
  const ids = byUid.get(uid)
  if (!ids?.size) return 0
  let n = 0
  for (const id of ids) {
    const item = items.get(id)
    if (item && !item.cancelled && (item.state === 'pending' || item.state === 'uploading')) n++
  }
  return n
}

/** 订阅某个会话的上传状态变化（弹窗用于把完成的上传加入附件展示列表） */
export function subscribeUploads(
  uid: string,
  fn: (item: BackgroundUploadState) => void,
): () => void {
  let set = listeners.get(uid)
  if (!set) {
    set = new Set()
    listeners.set(uid, set)
  }
  set.add(fn)
  return () => {
    set?.delete(fn)
    if (set && !set.size) listeners.delete(uid)
  }
}

/** 串行处理队列：一次只上传一个文件，逐个写回（与旧弹窗逐个上传行为一致） */
async function runQueue() {
  if (processing) return
  processing = true
  try {
    for (;;) {
      const item = nextPending()
      if (!item) break
      item.state = 'uploading'
      notify(item.uid, item)
      try {
        const meta = await uploadAttachment(item.creds, item.username, item.taskId, item.file)
        item.meta = meta
        if (item.cancelled) {
          item.state = 'cancelled'
          notify(item.uid, item)
          void deleteAttachments(item.creds, [meta])
          cleanupSessionIfEmpty(item.uid)
          continue
        }
        item.state = 'done'
        notify(item.uid, item)
        if (item.committed) void settleItem(item)
      } catch (e) {
        item.state = 'failed'
        item.error = (e as Error).message || '上传失败'
        notify(item.uid, item)
        if (item.committed) toastFailure(item)
        else if (item.meta) void deleteAttachments(item.creds, [item.meta])
        cleanupSessionIfEmpty(item.uid)
      }
    }
  } finally {
    processing = false
    if (nextPending()) void runQueue()
  }
}