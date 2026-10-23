import { Filter } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface ColumnFilterProps {
  label: string
  active: boolean
  children: ReactNode
}

/** Filter icon for a table header that opens a small popover holding the column's filter control. */
export function ColumnFilter({ label, active, children }: ColumnFilterProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      if (btn.current?.contains(t) || pop.current?.contains(t) || t.closest('[class*="rs__menu"]')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const close = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  function toggle() {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect()
      const width = 260
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`col-filter-btn${active ? ' active' : ''}`}
        aria-label={`Filter ${label}`}
        aria-expanded={open}
        onClick={toggle}
      >
        <Filter size={13} />
      </button>
      {open && (
        <div ref={pop} className="col-filter-pop" role="dialog" aria-label={`${label} filter`} style={{ top: pos.top, left: pos.left }}>
          {children}
        </div>
      )}
    </>
  )
}
