/**
 * stats.json 规范化迁移脚本（migrate-stats）。
 *
 * 把旧版「按天明细」结构（daily[YYYY-MM-DD] = { v, ts, tasks }，可能带 sealed）
 * 压缩成新版「月汇总 + 累计数」结构：
 *   { firstProjectAt, totalCompleted, daily: { 'YYYY-MM': { v, ts } }, updated_at }
 *
 * 用法（在 frontend 目录，先打包再跑）：
 *   node_modules/.bin/esbuild scripts/migrate-stats.ts --bundle --platform=node
 *     --format=esm --alias:@=<frontend>/src --outfile=scripts/migrate-stats.out.mjs
 *   node scripts/migrate-stats.out.mjs <旧 stats.json> [输出路径]
 *
 * 不指定输出路径时只打印统计信息（干跑），不写文件。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { migrateLegacyStats, purgeCompatDaily, sumMonthly } from '../src/utils/sync'

const input = process.argv[2]
const output = process.argv[3]
if (!input) {
  console.error('用法: node scripts/migrate-stats.out.mjs <旧 stats.json> [输出路径]')
  process.exit(1)
}

const raw = fs.readFileSync(input, 'utf8')
const parsed = JSON.parse(raw) as unknown
const before = raw.length
const { stats, changed, hadDayKeys } = migrateLegacyStats(parsed)
const legacyDays = Object.keys((parsed as { daily?: Record<string, unknown> }).daily ?? {}).filter((k) =>
  /^\d{4}-\d{2}-\d{2}$/.test(k),
)
const legacyTasks = Object.values((parsed as { daily?: Record<string, unknown> }).daily ?? {}).reduce(
  (n, e) => n + Object.keys((e as { tasks?: Record<string, unknown> }).tasks ?? {}).length,
  0,
)

console.log('=== stats.json 迁移（原型） ===')
console.log(`输入: ${path.resolve(input)}`)
console.log(`旧结构: 按天条目 ${legacyDays.length} 天，逐任务明细 ${legacyTasks} 条`)
console.log(`旧体积: ${before} B（${(before / 1024).toFixed(1)} KB）`)
console.log(`新结构: 月键 ${Object.keys(stats.daily ?? {}).length} 个 → ${Object.keys(stats.daily ?? {}).join(', ')}`)
console.log(`totalCompleted: ${stats.totalCompleted}  (Σ月键 v = ${sumMonthly(stats.daily)})`)
const compact = JSON.stringify(stats)
const pretty = JSON.stringify(stats, null, 4)
console.log(`新体积: 紧凑 ${compact.length} B / 美化 ${pretty.length} B`)
const purged = purgeCompatDaily(stats).stats
console.log(`清理兼容字段后: ${JSON.stringify(purged).length} B（紧凑）`)
console.log(`结构是否变化: ${changed ? '是（需要写回）' : '否（已是新结构）'}  ; 含旧按天明细: ${hadDayKeys ? '是' : '否'}`)
console.log(`累计数守恒: ${stats.totalCompleted === sumMonthly(stats.daily) ? '✔' : '✘'} (${stats.totalCompleted} vs ${sumMonthly(stats.daily)})`)

if (output) {
  fs.writeFileSync(output, JSON.stringify(stats, null, 4), 'utf8')
  console.log(`已写出: ${path.resolve(output)}`)
} else {
  console.log('（干跑：未写文件；如需写出请在第二个参数指定输出路径）')
}
