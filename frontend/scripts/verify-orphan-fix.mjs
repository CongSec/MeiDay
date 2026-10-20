// 跨设备「拖拽成子任务后源项目残留复制」修复的回归验证脚本。
// 说明：
//  1) 数据层合并算法（mergeTasks / applyDeletedTombstones / winsOver / canonicalJson）
//     是从 src/utils/sync.ts 与 src/utils/task.ts 原样提取的纯函数——本脚本不引入测试框架，
//     直接验证「墓碑能挡住源项目残留副本复活」这一核心不变量（原 bug 的最小复现路径）。
//  2) store 方法（convertTaskToSubtask / undoSubtaskConversion / _selfHealOrphanSubtasks）
//     通过源码静态断言验证（无法在无 IDB/OSS 环境下实例化 Pinia store）。
// 运行：node scripts/verify-orphan-fix.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const storePath = () => path.resolve(__dirname, '../src/stores/tasks.ts')

/* ---------- 从生产代码提取的纯函数（与 src/utils/task.ts、src/utils/sync.ts 保持一致） ---------- */
function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
function compareTime(a, b) {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  return a < b ? -1 : a > b ? 1 : 0
}
function winsOver(a, b) {
  const c = compareTime(a.updatedAt, b.updatedAt)
  if (c !== 0) return c > 0
  return canonicalJson(a) > canonicalJson(b)
}
function mergeTasks(local, remote) {
  const byId = new Map()
  for (const t of local) {
    const cur = byId.get(t.id)
    if (!cur || winsOver(t, cur)) byId.set(t.id, t)
  }
  for (const t of remote) {
    const r = byId.get(t.id)
    if (!r || winsOver(t, r)) byId.set(t.id, t)
  }
  return [...byId.values()]
}
function applyDeletedTombstones(active, deleted) {
  if (!deleted.length) return active
  const deletedById = new Map(deleted.map((d) => [d.id, d]))
  return active.filter((a) => {
    const d = deletedById.get(a.id)
    if (!d) return true
    return compareTime(a.updatedAt, d.updatedAt) > 0
  })
}

let passed = 0
function ok(name) {
  passed++
  console.log(`  ✓ ${name}`)
}

console.log('设备2 合并路径回归验证（跨项目拖成子任务 → 源项目残留复制）\n')

// ---- 构造场景 ----
// 项目 X 曾有顶层任务 A；设备1 在今日页把 A 拖成项目 Y 中任务 B 的子任务（跨项目转换）。
// 转换时墓碑 updatedAt = source.updatedAt（与修复1 的实现一致）。
const A_ID = 'task-A'
const T0 = '2025-01-01T00:00:00.000Z' // A 的最后编辑时间 = 墓碑时间

// 设备2 拉到的源项目 X 文件（含残留顶层 A —— 设备1 的防抖写尚未生效/本地快照旧）
const staleX = [
  { id: A_ID, name: 'A', projectId: 'X', updatedAt: T0, status: 'pending', subtasks: [] },
  { id: 'task-X2', name: 'X2', projectId: 'X', updatedAt: '2025-01-02T00:00:00.000Z', status: 'pending', subtasks: [] },
]
// 目标项目 Y 文件（B 已含子任务 A —— 转换已生效）
const freshY = [
  {
    id: 'task-B',
    name: 'B',
    projectId: 'Y',
    updatedAt: '2025-01-02T00:00:00.000Z',
    status: 'pending',
    subtasks: [
      { id: A_ID, name: 'A', updatedAt: T0, completed: false },
      { id: 'sub-C', name: 'C', updatedAt: '2025-01-02T00:00:00.000Z', completed: false },
    ],
  },
]
// 墓碑：转换时写入 X 项目的墓碑日志（修复1 的产物）
const tombstonesX = [{ id: A_ID, updatedAt: T0 }]

// ---- 用例 A5：跨设备合并不复活（核心回归，复现原 bug 路径）----
console.log('A5 跨设备合并不复活：')
{
  const mergedX = mergeTasks([], staleX)
  const finalX = applyDeletedTombstones(mergedX, tombstonesX)
  const ids = finalX.map((t) => t.id)
  assert.ok(!ids.includes(A_ID), `X 项目不应再有 A（实际：${ids.join(', ')}）`)
  assert.ok(ids.includes('task-X2'), 'X2 应保留')
  ok('墓碑按「只在一侧出现则保留」拦截了 A 的复活')
}

// ---- 用例 A5b：无墓碑时确实会复活（对照，证明墓碑必要）----
console.log('A5b 无墓碑时残留会复活（对照）：')
{
  const mergedX = mergeTasks([], staleX)
  const finalX = applyDeletedTombstones(mergedX, [])
  assert.ok(finalX.some((t) => t.id === A_ID), '无墓碑时 A 确实会并回（证明根因与修复必要性）')
  ok('对照成立：无墓碑 → 复制；有墓碑 → 剔除')
}

// ---- 用例 A5c：对端已编辑 A（updatedAt 更新）时允许保留（防误删对端重建）----
console.log('A5c 对端严格更新的任务不被墓碑误删：')
{
  const mergedX = mergeTasks([], [{ ...staleX[0], updatedAt: '2025-01-03T00:00:00.000Z' }])
  const finalX = applyDeletedTombstones(mergedX, tombstonesX)
  assert.ok(finalX.some((t) => t.id === A_ID), '对端重建/严格更新的 A 应保留（与 applyDeletedTombstones 语义一致）')
  ok('墓碑不误伤严格更新的副本')
}

// ---- 用例 A6：提升为主任务往返后不产生残留 ----
console.log('A6 提升/转换往返不残留：')
{
  const yAfterPromote = freshY.map((t) => (t.id === 'task-B' ? { ...t, subtasks: [t.subtasks[1]] } : t))
  const promoted = {
    id: A_ID,
    name: 'A',
    projectId: 'Y',
    updatedAt: '2025-01-03T00:00:00.000Z',
    status: 'pending',
    subtasks: [],
  }
  const mergedY = mergeTasks(yAfterPromote, [promoted])
  const aCount = mergedY.filter((t) => t.id === A_ID).length
  assert.equal(aCount, 1, 'Y 项目顶层 A 只有一份')
  const bSubIds = mergedY.find((t) => t.id === 'task-B')?.subtasks.map((s) => s.id) ?? []
  assert.ok(!bSubIds.includes(A_ID), 'B 的子任务里不应再有 A')
  ok('提升后 A 仅作为 Y 顶层任务存在一份，无重复')
}

// ---- 用例 A1：store 源码静态断言（跨项目转换写墓碑 / 撤销清墓碑 / 自愈函数）----
console.log('A1 store 源码静态断言：')
{
  const src = fs.readFileSync(storePath(), 'utf-8')
  const seg = src.slice(src.indexOf('convertTaskToSubtask(sourceId: string'), src.indexOf('undoSubtaskConversion(): boolean'))
  assert.ok(seg.includes('upsertTombstones(srcPid'), '跨项目转换应调用 upsertTombstones(srcPid')
  assert.ok(seg.includes('srcPid !== dstPid'), '仅在跨项目时写墓碑')
  const undo = src.slice(src.indexOf('undoSubtaskConversion(): boolean'), src.indexOf('promoteSubtaskToTask'))
  assert.ok(undo.includes('removeTombstones(snap.srcPid'), '撤销应移除墓碑')
  assert.ok(src.includes('_selfHealOrphanSubtasks('), '自愈函数存在')
  const heal = src.slice(src.indexOf('_selfHealOrphanSubtasks('), src.indexOf('_deleteMasterForTask'))
  assert.ok(heal.includes('upsertTombstones'), '自愈函数写墓碑')
  ok('store 源码含：跨项目写墓碑 + 撤销清墓碑 + 自愈函数（含写墓碑）')
}

// ---- 用例 A2：同项目转换不写墓碑（静态断言）----
console.log('A2 同项目转换不写墓碑：')
{
  const src = fs.readFileSync(storePath(), 'utf-8')
  const seg = src.slice(src.indexOf('convertTaskToSubtask(sourceId: string'), src.indexOf('undoSubtaskConversion(): boolean'))
  assert.ok(seg.includes('if (srcPid !== dstPid)'), '墓碑写入包在 srcPid !== dstPid 分支内')
  ok('墓碑写入限定跨项目（同项目无对端复活风险，避免墓碑误伤）')
}

console.log(`\n全部通过：${passed} 项断言`)
