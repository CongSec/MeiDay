/** 中国法定节假日 / 调休安排（按国务院公布整理，来源：timor.tech 假日 API）。
 *  仅收录已有官方安排的年份；未收录年份退回“周一至周五为工作日、周六周日休息”的标准判断。
 *  holidays：法定休息日（含调休补休，即使落在工作日也休息）；
 *  makeup：调休上班日（即使落在周末也要上班）。 */
const LEGAL_CALENDAR: Record<number, { holidays: string[]; makeup: string[] }> = {
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

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+08:00`).getDay()
}

/** 判断某天（YYYY-MM-DD）是否为中国法定工作日（含周末调休上班日，排除节假日） */
export function isLegalWorkday(dateKey: string): boolean {
  const year = Number(dateKey.slice(0, 4))
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
