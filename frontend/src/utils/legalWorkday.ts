/** 中国法定节假日 / 调休安排。
 *  优先使用 timor.tech 假日 API（官方安排，动态获取），结果缓存到 IndexedDB；
 *  离线/接口不可用时退回内置表（仅收录已有官方安排的年份），再退回“周一至周五为工作日”判断。
 *  holidays：法定休息日（含调休补休，即使落在工作日也休息）；
 *  makeup：调休上班日（即使落在周末也要上班）。 */
import { idbGet, idbPut } from './idb'

interface LegalYear {
  holidays: string[]
  makeup: string[]
}

/** 内置兜底表：仅收录已有官方安排的年份（后续年份依赖动态接口补齐）。 */
const LEGAL_CALENDAR: Record<number, LegalYear> = {
  2025: {
    holidays: [
      '2025-01-01',
      '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
      '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
      '2025-04-04', '2025-04-05', '2025-04-06',
      '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
      '2025-05-31', '2025-06-01', '2025-06-02',
      '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05',
      '2025-10-06', '2025-10-07', '2025-10-08',
    ],
    makeup: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11'],
  },
  2026: {
    holidays: [
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07',
    ],
    makeup: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
}

/** 动态获取到的年份覆盖表（内存缓存，优先于内置表）。 */
const extraCalendar = new Map<number, LegalYear>()

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+08:00`).getDay()
}

/** 解析 timor.tech 年度接口：{ code, holiday: { "MM-DD": { holiday, name, wage, date, rest } } }
 *  归一化为 { holidays, makeup }；解析失败返回 null（调用方走内置兜底）。 */
function parseTimorPayload(data: unknown, year: number): LegalYear | null {
  try {
    const map = (data as { holiday?: Record<string, { holiday?: boolean; date?: string }> })?.holiday
    if (!map || typeof map !== 'object') return null
    const holidays: string[] = []
    const makeup: string[] = []
    for (const key of Object.keys(map)) {
      const v = map[key]
      if (!v || typeof v !== 'object') continue
      const date = /^\d{4}-\d{2}-\d{2}$/.test(v.date ?? '') ? v.date! : `${year}-${key}`
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      if (v.holiday === true) holidays.push(date)
      else if (weekdayOf(date) === 0 || weekdayOf(date) === 6) makeup.push(date) // 周末调休上班日
    }
    if (!holidays.length && !makeup.length) return null
    return { holidays, makeup }
  } catch {
    return null
  }
}

/** 预取某年的法定节假日安排（timor.tech 动态接口），IDB 缓存 + 内置表兜底。
 *  失败静默：isLegalWorkday 继续用内置表/周一到周五判断，不阻塞主流程。 */
export async function ensureLegalCalendar(year: number): Promise<void> {
  if (extraCalendar.has(year)) return
  if (typeof window === 'undefined' || !('indexedDB' in window)) return
  try {
    const cached = await idbGet<LegalYear>('kv', `legal:${year}`)
    if (cached && cached.holidays) {
      extraCalendar.set(year, cached)
      return
    }
  } catch {
    /* 忽略缓存读取失败 */
  }
  try {
    const res = await fetch(`https://timor.tech/api/holiday/year/${year}`)
    if (!res.ok) return
    const cal = parseTimorPayload(await res.json(), year)
    if (!cal) return
    extraCalendar.set(year, cal)
    try {
      await idbPut('kv', `legal:${year}`, cal)
    } catch {
      /* 缓存写入失败不影响本次判断 */
    }
  } catch {
    /* 网络失败/接口不可用：保留内置兜底 */
  }
}

/** 判断某天（YYYY-MM-DD）是否为中国法定工作日（含周末调休上班日，排除节假日） */
function isLegalWorkday(dateKey: string): boolean {
  const year = Number(dateKey.slice(0, 4))
  const extra = extraCalendar.get(year)
  if (extra) {
    if (extra.holidays.includes(dateKey)) return false
    if (extra.makeup.includes(dateKey)) return true
  }
  const cal = LEGAL_CALENDAR[year]
  if (cal) {
    if (cal.holidays.includes(dateKey)) return false
    if (cal.makeup.includes(dateKey)) return true
  }
  const wd = weekdayOf(dateKey)
  return wd >= 1 && wd <= 5
}

/** 返回严格晚于 dateKey 的下一个法定工作日（YYYY-MM-DD） */
export function nextLegalWorkday(dateKey: string): string {
  let cur = dateKey
  for (let i = 0; i < 400; i++) {
    const [y, m, d] = cur.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d + 1))
    const pad = (n: number) => String(n).padStart(2, '0')
    cur = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
    if (isLegalWorkday(cur)) return cur
  }
  return cur
}