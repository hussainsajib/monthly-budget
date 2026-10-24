import { RANGE_OPTIONS, type RangeKey } from '../dateRange'

interface DateRangeFilterProps {
  rangeKey: RangeKey
  start: string
  end: string
  onRange: (key: RangeKey) => void
  onCustom: (values: { start: string; end: string }) => void
}

export function DateRangeFilter({ rangeKey, start, end, onRange, onCustom }: DateRangeFilterProps) {
  return (
    <>
      <div className="segmented" role="group" aria-label="Date range">
        {RANGE_OPTIONS.filter((o) => o.key !== 'custom').map((o) => (
          <button key={o.key} type="button" className={rangeKey === o.key ? 'on' : ''} onClick={() => onRange(o.key)}>
            {o.short}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor="hdr-start">From</label>
        <input id="hdr-start" type="date" value={start} onChange={(e) => onCustom({ start: e.target.value, end })} />
      </div>
      <div>
        <label htmlFor="hdr-end">To</label>
        <input id="hdr-end" type="date" value={end} onChange={(e) => onCustom({ start, end: e.target.value })} />
      </div>
    </>
  )
}
