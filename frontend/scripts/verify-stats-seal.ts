/**
 * stats.json 封口机制验证脚本（verify-stats-seal）。
 *
 * 用法（在 frontend 目录）：
 *   node_modules/.bin/esbuild scripts/verify-stats-seal.ts --bundle --platform=node
 *     --format=esm --alias:@=<frontend>/src --outfile=scripts/verify-stats-seal.out.mjs
 *   node scripts/verify-stats-seal.out.mjs
 *
 * 验证点：
 * 1. sealOldDays 幂等、封口后 v/ts 不变、无明细旧数据不加标记；
 * 2. 封口日多端合并不重复计数（sealed×sealed / sealed×明细 / 明细更新者胜出）；
 * 3. 旧版无明细条目合并语义保持不变（存量叠加）；
 * 4. 双设备迁移场景：一端封口、一端仍有明细，合并后总量不虚增、新增量不丢；
 * 5. 真实样例 output/stats.json：180 天窗口内不封口、封口前后 v 总和守恒。
 * 6. addDelta 的「封口日开封」逻辑（与 stores/stats.ts 中的实现保持一致，若有改动需同步）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { sealOldDays, mergeStats, STATS_SEAL_DAYS } from '../src/utils/sync'
import { addDaysKey, todayKey } from '../src/utils/time'
import type { StatsDailyEntry, UserStats } from '../src/types'

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
function totalV(s: UserStats | null | undefined): number {
  if (!s) return 0
  let t = 0
  for (const k in s.daily ?? {}) t += s.daily[k].v
  return t
}

console.log('[1] sealOldDays 幂等与计数守恒')
{
  const samplePath = process.argv[2] ?? path.resolve(process.cwd(), '../output/stats.json')
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as UserStats
  const before = totalV(sample)
  // 180 天窗口：当前样例全部日期应在窗口内 → 不封口（动态断言，避免依赖系统时钟）
  const cutoff180 = addDaysKey(todayKey(), -STATS_SEAL_DAYS)
  const expectedNoChange = Object.keys(sample.daily).every((k) => k >= cutoff180 || sample.daily[k].tasks == null)
  const r180 = sealOldDays(sample, STATS_SEAL_DAYS)
  check(
    '180 天窗口下样例不封口（changed 与动态预期一致）',
    r180.changed === !expectedNoChange,
    `changed=${r180.changed} expectedNoChange=${expectedNoChange} today=${todayKey()} cutoff=${cutoff180} days=${Object.keys(sample.daily).length}`,
  )
  check('sealOldDays 返回同一对象（原地收缩，store 依赖此行为）', r180.stats === sample)
  // 激进窗口 10 天：封口旧日期
  const r10 = sealOldDays(sample, 10)
  const sealedDays = Object.keys(r10.stats!.daily).filter((k) => r10.stats!.daily[k].sealed === true)
  check('10 天窗口下发生封口', r10.changed === true, `sealed=${sealedDays.length} 天`)
  check('封口后 v 总和守恒', totalV(r10.stats) === before, `before=${before} after=${totalV(r10.stats)}`)
  check(
    '封口条目无 tasks 且保留原 ts/v',
    sealedDays.every((k) => {
      const e = r10.stats!.daily[k]
      return e.tasks == null && typeof e.v === 'number' && !!e.ts
    }),
  )
  const legacyKeys = Object.keys(r10.stats!.daily).filter((k) => r10.stats!.daily[k].tasks == null && r10.stats!.daily[k].sealed !== true)
  check(
    '无明细旧数据（legacy）不加 sealed 标记（保持旧合并语义）',
    legacyKeys.every((k) => !r10.stats!.daily[k].sealed),
  )
  // 幂等：再跑一遍无变化
  const r10b = sealOldDays(r10.stats)
  check('再次封口幂等（无新变化）', r10b.changed === false)
}

console.log('[2] 封口日合并：不重复计数')
{
  const sealedA: UserStats = { daily: { '2026-01-01': { v: 10, ts: '2026-01-01T08:00:00+08:00', sealed: true } }, updated_at: '' }
  const sealedB: UserStats = { daily: { '2026-01-01': { v: 10, ts: '2026-01-01T08:00:00+08:00', sealed: true } }, updated_at: '' }
  const m = mergeStats(sealedA, sealedB)
  check('sealed×sealed 取其一而非叠加（10 而非 20）', m.daily['2026-01-01'].v === 10, `v=${m.daily['2026-01-01'].v}`)
  check('合并结果保持 sealed 标记', m.daily['2026-01-01'].sealed === true)

  const detSameTs: UserStats = {
    daily: {
      '2026-01-01': {
        v: 10,
        ts: '2026-01-01T08:00:00+08:00',
        tasks: { t1: { v: 1, ts: '2026-01-01T07:00:00+08:00' } },
      },
    },
    updated_at: '',
  }
  const m2 = mergeStats(sealedA, detSameTs)
  check('sealed×明细(ts 相同) 取封口侧、不叠加（10 而非 20）', m2.daily['2026-01-01'].v === 10, `v=${m2.daily['2026-01-01'].v}`)

  const detNewer: UserStats = {
    daily: {
      '2026-01-01': {
        v: 11,
        ts: '2026-01-01T09:00:00+08:00',
        tasks: { t1: { v: 1, ts: '2026-01-01T09:00:00+08:00' } },
      },
    },
    updated_at: '',
  }
  const m3 = mergeStats(sealedA, detNewer)
  check('明细侧更新者胜出、保留明细（11，包含封口后的新增量）', m3.daily['2026-01-01'].v === 11 && m3.daily['2026-01-01'].tasks != null, `v=${m3.daily['2026-01-01'].v}`)

  const sealedNewer: UserStats = {
    daily: { '2026-01-01': { v: 10, ts: '2026-01-01T10:00:00+08:00', sealed: true } },
    updated_at: '',
  }
  const m4 = mergeStats(sealedNewer, detNewer)
  check('封口侧更新者胜出（10 覆盖明细侧的旧 11，不叠加）', m4.daily['2026-01-01'].v === 10 && m4.daily['2026-01-01'].sealed === true, `v=${m4.daily['2026-01-01'].v}`)
}

console.log('[3] 旧版无明细条目语义保持不变')
{
  const legacyA: UserStats = { daily: { '2025-12-31': { v: 5, ts: '2025-12-31T20:00:00+08:00' } }, updated_at: '' }
  const legacyB: UserStats = { daily: { '2025-12-31': { v: 5, ts: '2025-12-31T21:00:00+08:00' } }, updated_at: '' }
  const m = mergeStats(legacyA, legacyB)
  check('legacy×legacy 仍按存量叠加（10，迁移期行为不变）', m.daily['2025-12-31'].v === 10, `v=${m.daily['2025-12-31'].v}`)

  const det: UserStats = {
    daily: {
      '2025-12-31': {
        v: 3,
        ts: '2025-12-31T22:00:00+08:00',
        tasks: { x: { v: 1, ts: '2025-12-31T22:00:00+08:00' }, y: { v: 1, ts: '2025-12-31T22:00:00+08:00' }, z: { v: 1, ts: '2025-12-31T22:00:00+08:00' } },
      },
    },
    updated_at: '',
  }
  const m2 = mergeStats(legacyA, det)
  check('legacy×明细 明细逐任务求和 + legacy 存量（3+5=8）', m2.daily['2025-12-31'].v === 8, `v=${m2.daily['2025-12-31'].v}`)
}

console.log('[4] 双设备迁移场景：总量不虚增、新增量不丢')
{
  const base: UserStats = {
    firstProjectAt: '2025-01-01T00:00:00+08:00',
    daily: {
      '2025-01-01': { v: 10, ts: '2025-01-01T20:00:00+08:00', tasks: { a: { v: 1, ts: '2025-01-01T20:00:00+08:00' } } },
      '2025-01-02': { v: 5, ts: '2025-01-02T20:00:00+08:00', tasks: { b: { v: 1, ts: '2025-01-02T20:00:00+08:00' } } },
    },
    updated_at: '',
  }
  // 设备 A：新版本，把旧日期封口
  const devA = sealOldDays(JSON.parse(JSON.stringify(base)), 30).stats!
  // 设备 B：旧版本/未封口，仍有明细，且比 A 多一条当天增量
  const devB: UserStats = JSON.parse(JSON.stringify(base)) as UserStats
  devB.daily['2025-01-02'] = {
    v: 6,
    ts: '2025-01-02T21:00:00+08:00',
    tasks: { b: { v: 1, ts: '2025-01-02T20:00:00+08:00' }, c: { v: 1, ts: '2025-01-02T21:00:00+08:00' } },
  }
  const m = mergeStats(devA, devB)
  const expectTotal = totalV(devA) + 1 // B 的新增量 1
  check('合并后总量 = 封口侧总量 + B 的新增量（不重复计数）', totalV(m) === expectTotal, `got=${totalV(m)} expect=${expectTotal}`)
  check('2025-01-01（双方都有，A 封口且 ts 更新/相同）不再叠加', m.daily['2025-01-01'].v === 10, `v=${m.daily['2025-01-01'].v}`)
  check('2025-01-02 取 B 的更新明细（6，保留新增量）', m.daily['2025-01-02'].v === 6, `v=${m.daily['2025-01-02'].v}`)
}

console.log('[5] addDelta「封口日开封」逻辑（与 stores/stats.ts 实现保持一致）')
{
  // 复刻 addDelta 中的开封表达式：封口日被再次写入时，保留已定型 v/ts、补回明细后累加
  const sealed: StatsDailyEntry = { v: 10, ts: '2025-01-01T20:00:00+08:00', sealed: true }
  const ts = '2025-01-02T09:00:00+08:00'
  const prev = sealed
  const cur = prev?.v ?? 0
  const delta = 1
  const entry: StatsDailyEntry = prev && !prev.sealed ? { ...prev } : { v: prev?.v ?? 0, ts: prev?.ts ?? ts }
  entry.tasks = entry.tasks ?? {}
  entry.tasks['r1'] = { v: delta > 0 ? 1 : 0, ts }
  const after: StatsDailyEntry = { ...entry, v: cur + delta, ts }
  check('开封后 v = 原定型值 + 新增量（11）', after.v === 11, `v=${after.v}`)
  check('开封后补回明细且去掉 sealed', after.tasks?.['r1'] != null && after.sealed !== true)
  check('开封未改变原定型计数语义', after.ts === ts && after.tasks!['r1'].v === 1)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
