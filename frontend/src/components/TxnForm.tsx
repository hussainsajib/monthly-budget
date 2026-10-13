import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { api } from '../api'
import { formatMoney } from '../money'
import { useAccounts, useCategories } from '../queries'
import type { DuplicateCandidate } from '../types'
import { AccountSelect, CategorySelect } from './selects'

export interface TxnFormValues {
  date: string
  description: string
  category_id: number | null
  account_id: number | null
  amount: string
  notes: string
}

interface Props {
  initial: TxnFormValues
  submitLabel: string
  onSubmit: (values: TxnFormValues & { category_id: number }) => Promise<void>
  /** Known descriptions for the datalist; also enables autofill of category/account/amount. */
  descriptions?: string[]
  big?: boolean
  plain?: boolean
  stacked?: boolean
  autoFocus?: boolean
  cascade?: boolean
  submitDisabled?: boolean
  onDirtyChange?: (dirty: boolean) => void
  extra?: ReactNode
  /** When set, looks for near-duplicates before saving and asks for confirmation. */
  findDuplicates?: (values: TxnFormValues & { category_id: number }) => Promise<DuplicateCandidate[]>
}

export default function TxnForm({ initial, submitLabel, onSubmit, descriptions, big, plain, stacked, autoFocus, cascade, submitDisabled, onDirtyChange, extra, findDuplicates }: Props) {
  const categories = useCategories()
  const accounts = useAccounts()
  const [v, setV] = useState<TxnFormValues>(initial)
  const [busy, setBusy] = useState(false)
  const [dups, setDups] = useState<DuplicateCandidate[] | null>(null)
  const dirty = (Object.keys(initial) as (keyof TxnFormValues)[]).some((k) => v[k] !== initial[k])
  const canSubmit = v.category_id !== null && !busy && !(submitDisabled ?? false) && dups === null
  const hint = busy
    ? null
    : v.category_id === null
      ? 'Choose a category before saving.'
      : submitDisabled
        ? 'Nothing has changed yet.'
        : null

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    setDups(null)
  }, [v])

  const set = <K extends keyof TxnFormValues>(key: K, value: TxnFormValues[K]) => setV((p) => ({ ...p, [key]: value }))

  async function autofill(text: string) {
    if (!descriptions || !text.trim() || v.category_id !== null) return
    const hit = await api.suggest(text).catch(() => null)
    if (!hit) return
    // Re-check against the latest state: never overwrite something typed while the request was in flight.
    setV((p) =>
      p.category_id !== null
        ? p
        : {
            ...p,
            category_id: hit.category_id,
            account_id: p.account_id ?? hit.account_id,
            amount: p.amount.trim() ? p.amount : hit.amount,
          },
    )
  }

  async function save() {
    if (v.category_id === null) return
    setBusy(true)
    try {
      await onSubmit({ ...v, category_id: v.category_id })
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (v.category_id === null || busy || submitDisabled) return
    if (dups !== null) {
      await save()
      return
    }
    if (findDuplicates) {
      setBusy(true)
      let found: DuplicateCandidate[] = []
      try {
        found = await findDuplicates({ ...v, category_id: v.category_id })
      } catch {
        found = []
      }
      setBusy(false)
      if (found.length > 0) {
        setDups(found)
        return
      }
    }
    await save()
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
      {stacked ? (
        <>
          <section className="form-section">
            <div className="form-grid">
              <div className="field-full">
                <label htmlFor="f-desc">Description</label>
                <input
                  id="f-desc"
                  type="text"
                  list={descriptions ? 'known-descriptions' : undefined}
                  autoComplete="off"
                  autoFocus={autoFocus}
                  required
                  value={v.description}
                  onChange={(e) => {
                    set('description', e.target.value)
                    if (descriptions?.some((d) => d.toLowerCase() === e.target.value.trim().toLowerCase()))
                      void autofill(e.target.value)
                  }}
                  onBlur={(e) => void autofill(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="f-amount">Amount (CAD)</label>
                <input
                  id="f-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  required
                  value={v.amount}
                  onChange={(e) => set('amount', e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="f-date">Date</label>
                <input id="f-date" type="date" required value={v.date} onChange={(e) => set('date', e.target.value)} />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>Category &amp; account</h2>
            <div className="form-grid">
              <div className="field-full category-cascade">
                <CategorySelect
                  id="f-category"
                  categories={categories.data ?? []}
                  value={v.category_id}
                  onChange={(id) => set('category_id', id)}
                  cascade={cascade}
                  required
                />
              </div>
              <div className="field-full">
                <label htmlFor="f-account">Account</label>
                <AccountSelect
                  id="f-account"
                  accounts={accounts.data ?? []}
                  value={v.account_id}
                  onChange={(id) => set('account_id', id)}
                />
              </div>
            </div>
          </section>
          <section className="form-section">
            <h2>Notes</h2>
            <div className="form-grid">
              <div className="field-full">
                <label htmlFor="f-notes">Notes</label>
                <textarea id="f-notes" rows={3} value={v.notes} onChange={(e) => set('notes', e.target.value)} />
              </div>
            </div>
          </section>
        </>
      ) : (
        <div className="grid txn-grid">
          <div>
            <label htmlFor="f-desc">Description</label>
            <input
              id="f-desc"
              type="text"
              list={descriptions ? 'known-descriptions' : undefined}
              autoComplete="off"
              required
              value={v.description}
              onChange={(e) => {
                set('description', e.target.value)
                if (descriptions?.some((d) => d.toLowerCase() === e.target.value.trim().toLowerCase()))
                  void autofill(e.target.value)
              }}
              onBlur={(e) => void autofill(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="f-amount">Amount (CAD)</label>
            <input
              id="f-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              required
              value={v.amount}
              onChange={(e) => set('amount', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="f-date">Date</label>
            <input id="f-date" type="date" required value={v.date} onChange={(e) => set('date', e.target.value)} />
          </div>
          <div>
            <CategorySelect
              id="f-category"
              categories={categories.data ?? []}
              value={v.category_id}
              onChange={(id) => set('category_id', id)}
              cascade={cascade}
              required
            />
          </div>
          <div>
            <label htmlFor="f-account">Account</label>
            <AccountSelect
              id="f-account"
              accounts={accounts.data ?? []}
              value={v.account_id}
              onChange={(id) => set('account_id', id)}
            />
          </div>
          <div>
            <label htmlFor="f-notes">Notes</label>
            <input id="f-notes" type="text" value={v.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>
      )}
      {descriptions && (
        <datalist id="known-descriptions">
          {descriptions.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      )}
      {descriptions && (
        <p className="small muted">
          Type a known description and the category, account and amount fill in automatically. Amounts like{' '}
          <code>61.09+1.37</code> work. Refunds: enter a negative amount.
        </p>
      )}
      {dups && (
        <div className="flash warn">
          <p className="small" style={{ margin: 0 }}>
            This looks like a transaction you already entered:
          </p>
          <ul>
            {dups.map((d) => (
              <li key={d.id}>
                {d.description} — {formatMoney(d.amount_cents)} on {d.date}
                {d.account_name ? ` (${d.account_name})` : ''}
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" onClick={() => void save()}>
              {submitLabel} anyway
            </button>
            <button type="button" className="secondary" onClick={() => setDups(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
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
