import { useCallback, useEffect, useRef, useState } from 'react'
import { LayoutGrid, List, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Bar } from './table'

export type ViewMode = 'list' | 'card'

const VIEW_KEY = 'mb-view'

function readStored(scope: string): ViewMode {
  try {
    return localStorage.getItem(`${VIEW_KEY}:${scope}`) === 'card' ? 'card' : 'list'
  } catch {
    return 'list'
  }
}

function storeView(scope: string, view: ViewMode) {
  try {
    localStorage.setItem(`${VIEW_KEY}:${scope}`, view)
  } catch {
    return
  }
}

/** List/card preference for one settings tab, remembered across visits. */
export function useViewMode(scope: string) {
  const [view, setView] = useState<ViewMode>(() => readStored(scope))
  const change = useCallback(
    (next: ViewMode) => {
      setView(next)
      storeView(scope, next)
    },
    [scope],
  )
  return { view, change }
}

/** Icon-only list/card switch. Both buttons carry a label and tooltip since they show no text. */
export function ViewToggle({
  view,
  onChange,
  tooltipId = 'settings-tip',
}: {
  view: ViewMode
  onChange: (v: ViewMode) => void
  tooltipId?: string
}) {
  return (
    <div className="view-toggle" role="group" aria-label="View mode">
      <button
        type="button"
        className={view === 'list' ? 'on' : ''}
        aria-pressed={view === 'list'}
        aria-label="View as list"
        data-tooltip-id={tooltipId}
        data-tooltip-content="List view"
        onClick={() => onChange('list')}
      >
        <List size={18} />
      </button>
      <button
        type="button"
        className={view === 'card' ? 'on' : ''}
        aria-pressed={view === 'card'}
        aria-label="View as cards"
        data-tooltip-id={tooltipId}
        data-tooltip-content="Card view"
        onClick={() => onChange('card')}
      >
        <LayoutGrid size={18} />
      </button>
    </div>
  )
}

export function Loading({ query }: { query: { isPending: boolean; isError: boolean; error: Error | null } }) {
  if (query.isError) return <div className="flash err">{query.error?.message ?? 'Failed to load'}</div>
  if (query.isPending) {
    return (
      <div className="card loading-skeleton" aria-busy="true">
        <Bar w={220} />
        <Bar w={340} />
        <Bar w={280} />
      </div>
    )
  }
  return null
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const el = ref.current
    const prev = document.activeElement as HTMLElement | null
    if (el && !el.contains(document.activeElement)) el.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !el) return
      const focusables = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn ghost" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
export function MonthField({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string
  label: string
  value: string
  onChange: (month: string) => void
  min?: string
  max?: string
}) {
  return (
    <div className="month-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="month" value={value} min={min} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </div>
  )
}
