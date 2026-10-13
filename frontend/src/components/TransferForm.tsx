import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useAccounts } from '../queries'
import { AccountSelect } from './selects'

export interface TransferFormValues {
  date: string
  description: string
  amount: string
  from_account_id: number | null
  to_account_id: number | null
  notes: string
}

interface Props {
  initial: TransferFormValues
  submitLabel: string
  onSubmit: (values: TransferFormValues) => Promise<void>
  plain?: boolean
  big?: boolean
  autoFocus?: boolean
  submitDisabled?: boolean
  onDirtyChange?: (dirty: boolean) => void
  extra?: ReactNode
}

export default function TransferForm({
  initial,
  submitLabel,
  onSubmit,
  plain,
  big,
  autoFocus,
  submitDisabled,
  onDirtyChange,
  extra,
}: Props) {
  const accounts = useAccounts()
  const [v, setV] = useState<TransferFormValues>(initial)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof TransferFormValues>(key: K, value: TransferFormValues[K]) =>
    setV((p) => ({ ...p, [key]: value }))
  const dirty = (Object.keys(initial) as (keyof TransferFormValues)[]).some((k) => v[k] !== initial[k])
  const filled = v.from_account_id !== null && v.to_account_id !== null && v.from_account_id !== v.to_account_id
  const canSubmit = filled && !busy && !(submitDisabled ?? false)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const hint = busy
    ? null
    : !filled
      ? 'Choose two different accounts.'
      : submitDisabled
        ? 'Nothing has changed yet.'
        : null
  const accountsExcludingFrom = (accounts.data ?? []).filter((a) => a.id !== v.from_account_id)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    try {
      await onSubmit({ ...v, to_account_id: v.to_account_id })
    } finally {
      setBusy(false)
    }
  }

  function onFormKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (canSubmit) void submit(e as unknown as FormEvent)
    }
  }

  return (
    <form
      className={`${plain ? '' : 'card '}${big ? 'big-form' : ''}`.trim()}
      onSubmit={submit}
      onKeyDown={onFormKeyDown}
    >
      <section className="form-section">
        <div className="form-grid">
          <div className="field-full">
            <label htmlFor="tr-desc">Description</label>
            <input
              id="tr-desc"
              type="text"
              autoComplete="off"
              autoFocus={autoFocus}
              value={v.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="tr-amount">Amount (CAD)</label>
            <input
              id="tr-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              required
              value={v.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="tr-date">Date</label>
            <input id="tr-date" type="date" required value={v.date} onChange={(e) => set('date', e.target.value)} />
          </div>
        </div>
      </section>
      <section className="form-section">
        <h2>Move money</h2>
        <div className="form-grid">
          <div className="field-full">
            <label htmlFor="tr-from">From account</label>
            <AccountSelect
              id="tr-from"
              accounts={accounts.data ?? []}
              value={v.from_account_id}
              onChange={(id) => {
                set('from_account_id', id)
                if (id != null && v.to_account_id === id) set('to_account_id', null)
              }}
            />
          </div>
          <div className="field-full">
            <label htmlFor="tr-to">To account</label>
            <AccountSelect
              id="tr-to"
              accounts={accountsExcludingFrom}
              value={v.to_account_id}
              onChange={(id) => set('to_account_id', id)}
            />
          </div>
        </div>
      </section>
      <section className="form-section">
        <h2>Notes</h2>
        <div className="form-grid">
          <div className="field-full">
            <label htmlFor="tr-notes">Notes</label>
            <textarea id="tr-notes" rows={3} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>
      </section>
      <div className="row form-actions">
        <button type="submit" disabled={!canSubmit}>
          {submitLabel}
        </button>
        {extra}
      </div>
      {hint && <p className="small muted">{hint}</p>}
    </form>
  )
}