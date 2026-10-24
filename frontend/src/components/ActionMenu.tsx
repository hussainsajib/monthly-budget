import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface ActionMenuItem {
  key: string
  label: string
  onSelect: () => void
}

interface ActionMenuProps {
  label: string
  items: ActionMenuItem[]
  children: ReactNode
  tooltipId?: string
  tooltip?: string
}

export function ActionMenu({ label, items, children, tooltipId, tooltip }: ActionMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btn.current?.contains(t) || pop.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btn.current?.focus()
    }
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

  useEffect(() => {
    if (open) pop.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [open])

  function toggle() {
    if (!open && btn.current) {
      const r = btn.current.getBoundingClientRect()
      const width = 200
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip-id={tooltipId}
        data-tooltip-content={tooltip}
        onClick={toggle}
      >
        {children}
      </button>
      {open && (
        <div ref={pop} className="action-menu" role="menu" aria-label={label} style={{ top: pos.top, left: pos.left }}>
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
