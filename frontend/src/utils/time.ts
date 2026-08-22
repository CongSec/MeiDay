const TZ_SUFFIX = '+08:00'

export function nowIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${TZ_SUFFIX}`
}

export function todayKey(): string {
  return nowIso().slice(0, 10)
}

/** "2026-08-17T10:00" -> "2026-08-17T10:00:00+08:00" */
export function fromLocalInput(value: string): string {
  if (!value) return ''
  const dt = value.length === 16 ? `${value}:00` : value
  return dt.length === 19 ? `${dt}${TZ_SUFFIX}` : dt
}

/** "2026-08-17T10:00:00+08:00" -> "2026-08-17T10:00"（datetime-local 值） */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  return iso.slice(0, 16)
}

export function dateKeyOf(iso: string): string {
  return iso.slice(0, 10)
}

export function formatDisplay(iso: string | null | undefined): string {
  if (!iso) return '-'
  const [, time] = iso.split('T')
  return `${iso.slice(5, 10)} ${time ? time.slice(0, 5) : ''}`
}

export function formatTodayTitle(iso: string): string {
  const [, time] = iso.split('T')
  return `${iso.slice(5, 10)} ${time ? time.slice(0, 5) : ''}`
}

/** 仅用于展示，不改变语义（全程东八区，不做 UTC 转换） */
export function isInRange(iso: string, startKey: string, endKey: string): boolean {
  const k = dateKeyOf(iso)
  return k >= startKey && k <= endKey
}

export function sortByEndTime<T extends { endTime: string }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => (a.endTime || '').localeCompare(b.endTime || ''))
}


/** 给带 +08:00 后缀的 ISO 时间增加 N 天（保留时分秒），用于重复任务日期顺延 */
export function addDays(iso: string, days: number): string {
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return iso
  const shifted = new Date(dt.getTime() + days * 86400000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
  const time = iso.includes('T') ? (iso.split('T')[1] ?? '') : ''
  return time ? `${base}T${time}` : base
}

/** 日期键（YYYY-MM-DD）加 N 天 */
export function addDaysKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** 两个日期键之间的天数差（toKey - fromKey） */
export function diffDaysKey(fromKey: string, toKey: string): number {
  const a = new Date(`${fromKey}T00:00:00+08:00`).getTime()
  const b = new Date(`${toKey}T00:00:00+08:00`).getTime()
  return Math.round((b - a) / 86400000)
}
