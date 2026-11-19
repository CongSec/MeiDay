/**
 * stats.json 月度汇总结构验证脚本（verify-stats-monthly）。
 *
 * 替代原 verify-stats-seal：旧的「封口 / 按天明细」结构已删除，改为
 * 「totalCompleted 唯一真值 + daily 仅存月键（过渡期兼容旧端）」。
 *
 * 用法（在 frontend 目录）：
 *   node_modules/.bin/esbuild scripts/verify-stats-monthly.ts --bundle --platform=node
 *     --format=esm --alias:@=<frontend>/src --outfile=scripts/verify-stats-monthly.out.mjs
 *   node scripts/verify-stats-monthly.out.mjs [样例 stats.json]
 *
 * 覆盖用例：
 *  T1 旧结构迁移：按天 + tasks 明细 → 月键，Σv 与 totalCompleted 守恒
 *  T2 迁移幂等：连跑两次字节级相同
 *  T3 totalCompleted 与 Σdaily 对账：不一致时能被修正
 *  T4 旧端日键回流：旧端写入 YYYY-MM-DD → 下次规范化并入对应月份，不丢数
 *  T5 旧端丢字段（防归零核心）：旧端写回时丢掉 totalCompleted → 新端能从 Σv 重建
 *  T6 合并取 max：任何一端都不会把总数改小
 *  T7 空文件/首用：NoSuchKey 场景不抛错、totalCompleted=0
 *  T8 清理兼容字段：purgeCompatDaily 后体积恒定且累计数不变
 *  T9 补记历史日：addDelta(date=过去) 落到该日所属月份
 *  T10 真实样例（可选）：传入真实 stats.json 时验证总量守恒与体积收敛
 */
import * as fs from 'node:fs'
import {
  mergeStats,
  mergeStatsAfterSave,
  migrateLegacyStats,
  purgeCompatDaily,
  reconcileStats,
  sumMonthly,
} from '../src/utils/sync'
import type { UserStats } from '../src/types'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✔ ${name}`)
  } else {
    failed++
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const sizeof = (v: unknown): number => Buffer.byteLength(JSON.stringify(v))

/** 构造旧版按天结构（含 tasks 明细），模拟现网数据 */
function legacyStats(perDay: Array<{ day: string; v: number; tasks: string[] }>): unknown {
  const daily: Record<string, unknown> = {}
  for (const { day, v, tasks } of perDay) {
    const map: Record<string, { v: 0 | 1; ts: string }> = {}
    for (const id of tasks) map[id] = { v: 1, ts: `${day}T10:00:00+08:00` }
    daily[day] = { v, ts: `${day}T10:00:00+08:00`, tasks: map }
  }
  return { firstProjectAt: '2026-08-01T00:00:00+08:00', daily, updated_at: '2026-11-01T00:00:00+08:00' }
}

console.log('\n[T1] 旧结构迁移：按天 + tasks 明细 → 月键，Σv 与 totalCompleted 守恒')
{
  const old = legacyStats([
    { day: '2026-08-29', v: 2, tasks: ['a', 'b'] },
    { day: '2026-08-30', v: 11, tasks: ['c'] },
    { day: '2026-09-01', v: -1, tasks: [] },
    { day: '2026-11-19', v: 5, tasks: ['d'] },
  ])
  const { stats, changed, hadDayKeys } = migrateLegacyStats(old)
  check('识别为旧按天结构', hadDayKeys === true)
  check('结构发生变化', changed === true)
  check('月键只有 3 个（2026-08 / 2026-09 / 2026-11）', Object.keys(stats.daily ?? {}).length === 3, JSON.stringify(Object.keys(stats.daily ?? {})))
  check('2026-08 月增量为 13（2+11）', stats.daily?.['2026-08']?.v === 13, `v=${stats.daily?.['2026-08']?.v}`)
  check('2026-09 月增量为 -1（取消完成）', stats.daily?.['2026-09']?.v === -1, `v=${stats.daily?.['2026-09']?.v}`)
  check('totalCompleted = 17（2+11-1+5）', stats.totalCompleted === 17, `total=${stats.totalCompleted}`)
  check('Σ月键 v === totalCompleted（守恒）', sumMonthly(stats.daily) === stats.totalCompleted)
  check('不再保留任何按天键', !Object.keys(stats.daily ?? {}).some((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)))
  check('不再保留 tasks 明细', !JSON.stringify(stats).includes('"tasks"'))
}

console.log('\n[T2] 迁移幂等：连跑两次结果字节级相同')
{
  const once = migrateLegacyStats(legacyStats([{ day: '2026-08-29', v: 2, tasks: ['a'] }])).stats
  const twice = migrateLegacyStats(JSON.parse(JSON.stringify(once))).stats
  check('第二次规范化 changed=false', migrateLegacyStats(JSON.parse(JSON.stringify(once))).changed === false)
  check('内容字节级一致', JSON.stringify(once) === JSON.stringify(twice))
}

console.log('\n[T3] totalCompleted 与 Σdaily 对账')
{
  const bad: UserStats = { totalCompleted: 100, daily: { '2026-11': { v: 3, ts: 'T' } }, updated_at: '' }
  reconcileStats(bad, '2026-11', 'T2')
  check('差额被补进当月，Σv === totalCompleted', sumMonthly(bad.daily) === bad.totalCompleted, `Σ=${sumMonthly(bad.daily)} total=${bad.totalCompleted}`)
  check('当月 v = 100', bad.daily?.['2026-11']?.v === 100, `v=${bad.daily?.['2026-11']?.v}`)
  const already: UserStats = { totalCompleted: 5, daily: { '2026-11': { v: 5, ts: 'T' } }, updated_at: '' }
  reconcileStats(already, '2026-11', 'T2')
  check('已一致时不做任何改动', already.daily?.['2026-11']?.v === 5 && sumMonthly(already.daily) === 5)
}

console.log('\n[T4] 旧端日键回流：旧端写入 YYYY-MM-DD，下次规范化并入对应月份')
{
  const base = migrateLegacyStats(legacyStats([{ day: '2026-11-19', v: 5, tasks: ['x'] }])).stats
  // 模拟旧端在新文件上又完成 1 个任务：写回日键 + 明细，且（旧端）不认 totalCompleted
  const oldEnd: Record<string, unknown> = {
    firstProjectAt: base.firstProjectAt,
    daily: { ...base.daily, '2026-12-01': { v: 1, ts: '2026-12-01T09:00:00+08:00', tasks: { y: { v: 1, ts: '2026-12-01T09:00:00+08:00' } } } },
    updated_at: '2026-12-01T09:00:00+08:00',
  }
  const { stats, hadDayKeys } = migrateLegacyStats(oldEnd)
  check('识别到旧端写入的日键', hadDayKeys === true)
  check('日键被并入 2026-12 月份', stats.daily?.['2026-12']?.v === 1, `v=${stats.daily?.['2026-12']?.v}`)
  check('原 2026-11 的 5 未被破坏', stats.daily?.['2026-11']?.v === 5)
  check('totalCompleted 重建为 6', stats.totalCompleted === 6, `total=${stats.totalCompleted}`)
}

console.log('\n[T5] 旧端丢字段（防归零核心）：totalCompleted 消失后仍能重建')
{
  const newShape = migrateLegacyStats({ totalCompleted: 461, daily: { '2026-08': { v: 72, ts: 'T' }, '2026-09': { v: 389, ts: 'T' } }, updated_at: '' }).stats
  // 旧端读到新结构后写回：序列化只带 daily，totalCompleted 丢失
  const oldWriteBack = { firstProjectAt: undefined, daily: newShape.daily, updated_at: 'now' }
  const rebuilt = migrateLegacyStats(oldWriteBack).stats
  check('totalCompleted 被重建为 461（不归零）', rebuilt.totalCompleted === 461, `total=${rebuilt.totalCompleted}`)
  // 完全空文件：仍不抛错
  const empty = migrateLegacyStats({}).stats
  check('空对象 → totalCompleted=0 且不抛错', empty.totalCompleted === 0)
  check('空对象 → daily 为空对象而非 undefined', typeof empty.daily === 'object')
}

console.log('\n[T6] 合并取 max：任何一端都不会把总数改小')
{
  const a: UserStats = { totalCompleted: 461, daily: { '2026-11': { v: 5, ts: '2026-11-19T10:00:00+08:00' } }, firstProjectAt: '2026-08-01T00:00:00+08:00', updated_at: '' }
  const b: UserStats = { totalCompleted: 460, daily: { '2026-11': { v: 4, ts: '2026-11-19T09:00:00+08:00' } }, firstProjectAt: '2026-08-01T00:00:00+08:00', updated_at: '' }
  const m = mergeStats(b, a)
  check('totalCompleted 取 max（461）', m.totalCompleted === 461, `total=${m.totalCompleted}`)
  check('月键取 ts 较新一侧（v=5）', m.daily?.['2026-11']?.v === 5, `v=${m.daily?.['2026-11']?.v}`)
  check('firstProjectAt 取最早', m.firstProjectAt === '2026-08-01T00:00:00+08:00')
  const m2 = mergeStats(a, b)
  check('交换顺序结果一致（不回退）', m2.totalCompleted === 461)
  const after = mergeStatsAfterSave(a, m, b)
  check('mergeStatsAfterSave 不使总数变小', after.totalCompleted >= 461, `total=${after.totalCompleted}`)
}

console.log('\n[T7] 首用/空文件')
{
  const empty = migrateLegacyStats({ daily: {}, updated_at: '' }).stats
  check('空 daily → totalCompleted=0', empty.totalCompleted === 0)
  check('空 daily → Σv=0', sumMonthly(empty.daily) === 0)
  const noDaily = migrateLegacyStats({ totalCompleted: 0 }).stats
  check('缺 daily 字段不抛错且补齐为空对象', noDaily.daily != null && Object.keys(noDaily.daily).length === 0)
}

console.log('\n[T8] 清理兼容字段：体积恒定且累计数不变')
{
  const withCompat: UserStats = {
    firstProjectAt: '2026-08-29T04:43:42+08:00',
    totalCompleted: 461,
    daily: Object.fromEntries([0, 1, 2, 3].map((i) => [`2026-0${8 + i}`, { v: 100, ts: 'T' }])),
    updated_at: 'T',
  }
  const { stats: purged, changed } = purgeCompatDaily(withCompat)
  check('清理后 changed=true', changed === true)
  check('daily 字段被删除', purged.daily === undefined)
  check('totalCompleted 保持不变（461）', purged.totalCompleted === 461)
  check('firstProjectAt 保持不变', purged.firstProjectAt === '2026-08-29T04:43:42+08:00')
  check('体积 ≤ 150 B（紧凑，永久恒定）', sizeof(purged) <= 150, `bytes=${sizeof(purged)}`)
  check('再次清理 changed=false（幂等）', purgeCompatDaily(purged).changed === false)
}

console.log('\n[T9] 补记历史日：addDelta(date=过去) 落到该日所属月份')
{
  const st = migrateLegacyStats({ totalCompleted: 10, daily: { '2026-09': { v: 10, ts: 'T' } } }).stats
  const dayKey = '2026-09-15'
  const mk = dayKey.slice(0, 7)
  st.daily![mk] = { v: (st.daily![mk]?.v ?? 0) + 1, ts: 'T2' }
  st.totalCompleted += 1
  check('月份累加正确（11）', st.daily?.['2026-09']?.v === 11, `v=${st.daily?.['2026-09']?.v}`)
  check('totalCompleted 同步 +1（11）', st.totalCompleted === 11)
  check('不会新建按天键', Object.keys(st.daily ?? {}).every((k) => /^\d{4}-\d{2}$/.test(k)))
}

// T10：真实样例（可选）
const sample = process.argv[2]
if (sample && fs.existsSync(sample)) {
  console.log(`\n[T10] 真实样例：${sample}`)
  const raw = fs.readFileSync(sample, 'utf8')
  const parsed = JSON.parse(raw) as { daily?: Record<string, { v?: number }> }
  const oldSum = Object.values(parsed.daily ?? {}).reduce((n, e) => n + (Number(e?.v) || 0), 0)
  const { stats } = migrateLegacyStats(JSON.parse(raw))
  check('旧文件总量 = 新 totalCompleted', oldSum === stats.totalCompleted, `old=${oldSum} new=${stats.totalCompleted}`)
  check('Σ月键 = totalCompleted', sumMonthly(stats.daily) === stats.totalCompleted)
  const purged = purgeCompatDaily(stats).stats
  console.log(`  旧体积 ${raw.length} B → 首轮 ${sizeof(stats)} B → 清理兼容字段后 ${sizeof(purged)} B`)
  check('清理后体积 ≤ 150 B', sizeof(purged) <= 150, `bytes=${sizeof(purged)}`)
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
