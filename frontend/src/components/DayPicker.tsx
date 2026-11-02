import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { RANGE_OPTIONS, rangeDates, type RangeKey } from '../dateRange'

const PRESETS = RANGE_OPTIONS.filter((o) => o.key !== 'all' && o.key !== 'custom')

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`

interface View {
  y: number
  m: number
}

function parse(v: string): View | null {
  const hit = /^(\d{4})-(\d{2})-\d{2}$/.exec(v)
  return hit ? { y: Number(hit[1]), m: Number(hit[2]) - 1 } : null
}

function Month({
  view,
  start,
  end,
  today,
  anchor,
  hover,
  onPick,
  onHover,
}: {
  view: View
  start: string
  end: string
  today: string
  anchor: string | null
  hover: string | null
  onPick: (iso: string) => void
  onHover: (iso: string | null) => void
}) {
  const lo = anchor && hover ? (hover < anchor ? hover : anchor) : start
  const hi = anchor && hover ? (hover < anchor ? anchor : hover) : end
  const first = new Date(view.y, view.m, 1)
  const days = new Date(view.y, view.m + 1, 0).getDate()
  return (
    <div className="daypicker-month">
      <div className="daypicker-title">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
      <div className="daypicker-grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="daypicker-dow">
            {w}
          </span>
        ))}
        {Array.from({ length: first.getDay() }, (_, i) => (
          <span key={`b${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const d = iso(view.y, view.m, i + 1)
          const edge = anchor && hover ? d === lo || d === hi : d === start || d === end
          const inside = !!lo && !!hi && d > lo && d < hi
          const cls = ['daypicker-day', edge ? 'on' : '', inside ? 'between' : '', d === today ? 'today' : '']
            .filter(Boolean)
            .join(' ')
          return (
            <button key={d} type="button" className={cls} aria-pressed={edge} onClick={() => onPick(d)}
              onMouseEnter={() => onHover(d)}
            >
              {i + 1}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function RangePicker({
  start,
  end,
  onChange,
}: {
  start: string
  end: string
  onChange: (range: { start: string; end: string }, done: boolean) => void
}) {
  const now = new Date()
  const [view, setView] = useState<View>(parse(start) ?? { y: now.getFullYear(), m: now.getMonth() })
  const [anchor, setAnchor] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const today = iso(now.getFullYear(), now.getMonth(), now.getDate())
  const shift = (by: number) => {
    const d = new Date(view.y, view.m + by, 1)
    setView({ y: d.getFullYear(), m: d.getMonth() })
  }
  const next = new Date(view.y, view.m + 1, 1)

  function pick(d: string) {
    if (anchor === null) {
      setAnchor(d)
      setHover(d)
      onChange({ start: d, end: '' }, false)
      return
    }
    setAnchor(null)
    setHover(null)
    onChange(d < anchor ? { start: d, end: anchor } : { start: anchor, end: d }, true)
  }

  return (
    <div className="daypicker" role="group" aria-label="Custom date range">
      <div className="daypicker-head">
        <button type="button" className="icon-btn ghost" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft size={16} />
        </button>
        <span className="daypicker-hint">
          {anchor !== null
            ? `${anchor} → pick the last day`
            : start && end
              ? `${start} → ${end}. Pick a first day to change it`
              : 'Pick the first day'}
        </span>
        <button type="button" className="icon-btn ghost" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="daypicker-months" onMouseLeave={() => setHover(null)}>
        <Month view={view} start={start} end={end} today={today} anchor={anchor} hover={hover} onPick={pick} onHover={setHover} />
        <Month
          view={{ y: next.getFullYear(), m: next.getMonth() }}
          start={start}
          end={end}
          today={today}
          anchor={anchor}
          hover={hover}
          onPick={pick}
          onHover={setHover}
        />
      </div>
      <div className="daypicker-presets">
        {PRESETS.map((o) => (
          <button
            key={o.key}
            type="button"
            className="secondary small shrink"
            onClick={() => {
              setAnchor(null)
              onChange(rangeDates(o.key as Exclude<RangeKey, 'all' | 'custom'>), true)
            }}
          >
            {o.full}
          </button>
        ))}
      </div>
    </div>
  )
}
