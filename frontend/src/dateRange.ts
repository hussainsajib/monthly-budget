export type RangeKey = 'all' | 'month' | 'days30' | 'ytd' | 'custom'

export const RANGE_OPTIONS: Array<{ key: RangeKey; short: string; full: string }> = [
  { key: 'all', short: 'All', full: 'All time' },
  { key: 'month', short: 'Month', full: 'This month' },
  { key: 'days30', short: '30d', full: 'Last 30 days' },
  { key: 'ytd', short: 'YTD', full: 'Year to date' },
  { key: 'custom', short: 'Custom', full: 'Custom' },
]

const isoOf = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function rangeDates(key: Exclude<RangeKey, 'all' | 'custom'>): { start: string; end: string } {
  const now = new Date()
  if (key === 'month') {
    return {
      start: isoOf(new Date(now.getFullYear(), now.getMonth(), 1)),
      end: isoOf(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    }
  }
  if (key === 'days30') {
    const s = new Date(now)
    s.setDate(s.getDate() - 29)
    return { start: isoOf(s), end: isoOf(now) }
  }
  return { start: isoOf(new Date(now.getFullYear(), 0, 1)), end: isoOf(now) }
}

export function parseRangeKey(v: string | null | undefined): RangeKey {
  return v === 'custom' || v === 'month' || v === 'days30' || v === 'ytd' ? v : 'all'
}

export function resolveRange(key: RangeKey, start: string, end: string): { start: string; end: string } {
  if (key === 'custom') return { start, end }
  if (key === 'all') return { start: '', end: '' }
  return rangeDates(key)
}
