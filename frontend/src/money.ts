/** Amounts are integer cents everywhere; the server parses typed amounts like "61.09+1.37". */

const FORMAT = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

export function formatMoney(cents: number | null | undefined, blankZero = false): string {
  if (cents == null || (blankZero && cents === 0)) return ''
  return FORMAT.format((Object.is(cents, -0) ? 0 : cents) / 100)
}

/** Plain "12.34" for form inputs. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents == null) return ''
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-11' -> 'Nov', or 'Nov 2026' when the year is needed to tell two months apart. */
export function monthLabel(ym: string, withYear = false): string {
  const [year, month] = ym.split('-')
  return withYear ? `${MONTHS[Number(month) - 1]} ${year}` : MONTHS[Number(month) - 1]
}
