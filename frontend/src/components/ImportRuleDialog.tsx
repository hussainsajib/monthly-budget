import { Plus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { centsToInput } from '../money'
import { useAccounts, useImportCategories } from '../queries'
import { useRun, useToast } from '../toast'
import type { ImportRule, ImportRuleBody } from '../types'
import { AddCategoryModal } from './AddCategoryModal'
import { AccountSelect, CategorySelect } from './selects'
import { Modal } from './ui'
import { Tooltip } from 'react-tooltip'

export interface RuleDraft {
  match_text: string
  amount: string
  account_id: number | null
  day_from: number | null
  day_to: number | null
  category_id: number | null
  is_active: boolean
}

export const EMPTY_RULE: RuleDraft = {
  match_text: '',
  amount: '',
  account_id: null,
  day_from: null,
  day_to: null,
  category_id: null,
  is_active: true,
}

export const ruleToDraft = (r: ImportRule): RuleDraft & { account_id: number; category_id: number } => ({
  match_text: r.match_text,
  amount: centsToInput(r.amount_cents),
  account_id: r.account_id,
  day_from: r.day_from,
  day_to: r.day_to,
  category_id: r.category_id,
  is_active: r.is_active,
})

/** A rule needs at least one of description, amount or day to identify a transaction. */
export const hasIdentifier = (d: RuleDraft) =>
  d.match_text.trim() !== '' || d.amount.trim() !== '' || d.day_from !== null || d.day_to !== null

export function draftToBody(d: RuleDraft & { account_id: number; category_id: number }, sortOrder = 0): ImportRuleBody {
  return {
    match_text: d.match_text,
    amount: d.amount || null,
    account_id: d.account_id,
    day_from: d.day_from,
    day_to: d.day_to,
    category_id: d.category_id,
    sort_order: sortOrder,
    is_active: d.is_active,
  }
}

export function DraftFields({ draft, onChange, idPrefix }: { draft: RuleDraft; onChange: (d: RuleDraft) => void; idPrefix: string }) {
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...draft, [k]: v })
  const accounts = useAccounts().data ?? []
  const categories = useImportCategories().data ?? []
  const [adding, setAdding] = useState(false)
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-text`}>Description contains</label>
        <input
          id={`${idPrefix}-text`}
          type="text"
          autoFocus
          maxLength={256}
          placeholder="e.g. NETFLIX | SPOTIFY"
          value={draft.match_text}
          onChange={(e) => set('match_text', e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-amount`}>Amount is ($)</label>
        <input
          id={`${idPrefix}-amount`}
          type="text"
          inputMode="decimal"
          placeholder="e.g. 9.99"
          value={draft.amount}
          onChange={(e) => set('amount', e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-account`}>Account</label>
        <AccountSelect
          id={`${idPrefix}-account`}
          accounts={accounts}
          value={draft.account_id}
          onChange={(id) => set('account_id', id)}
          blank="Choose an account…"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-from`}>Day of month from</label>
        <input
          id={`${idPrefix}-from`}
          type="number"
          min={1}
          max={31}
          placeholder="1-31"
          value={draft.day_from ?? ''}
          onChange={(e) => set('day_from', e.target.value === '' ? null : Number(e.target.value))}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-to`}>Day of month to</label>
        <input
          id={`${idPrefix}-to`}
          type="number"
          min={1}
          max={31}
          placeholder="1-31"
          value={draft.day_to ?? ''}
          onChange={(e) => set('day_to', e.target.value === '' ? null : Number(e.target.value))}
        />
      </div>
      <div className="form-grid field-full category-cascade">
        <div>
          <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <label style={{ margin: 0 }}>Category</label>
            <button
              type="button"
              className="icon-btn ghost"
              style={{ minWidth: 28, minHeight: 28 }}
              aria-label="Add a category"
              data-tooltip-id="rule-tip"
              data-tooltip-content="Add a category"
              onClick={() => setAdding(true)}
            >
              <Plus size={16} />
            </button>
          </div>
          <CategorySelect categories={categories} value={draft.category_id} onChange={(id) => set('category_id', id)} cascade />
        </div>
      </div>
      {adding && (
        <AddCategoryModal
          categories={categories}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false)
            set('category_id', id)
          }}
        />
      )}
    </>
  )
}

/** The "Add import rule" dialog used from the rules tab and prefilled from an import preview row. */
export function AddImportRuleModal({
  initial = EMPTY_RULE,
  onClose,
  onAdded,
}: {
  initial?: RuleDraft
  onClose: () => void
  onAdded?: () => void
}) {
  const run = useRun()
  const { fail } = useToast()
  const [draft, setDraft] = useState<RuleDraft>(initial)

  function valid(d: RuleDraft): d is RuleDraft & { account_id: number; category_id: number } {
    if (!hasIdentifier(d)) return fail('Add a description, an amount, or a date to identify the transaction') ?? false
    if (d.account_id == null) return fail('Pick an account') ?? false
    if (d.category_id == null) return fail('Pick a category') ?? false
    return true
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid(draft)) return
    if (await run(() => api.createImportRule(draftToBody(draft)), 'Added rule')) {
      onAdded?.()
      onClose()
    }
  }

  return (
    <Modal title="Add import rule" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <DraftFields draft={draft} onChange={setDraft} idPrefix="rule-add" />
        </div>
        <p className="small muted">
          Fill in at least one of description, amount or date; the more you add, the narrower the match. Separate description
          phrases with | to match any one of them. Give a start and/or end date to scope when the rule applies.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="shrink with-icon" type="submit">
            <img src="/static/add.svg?v=2" alt="" className="icon-img" /> Add rule
          </button>
          <button className="secondary shrink with-icon" type="button" onClick={onClose}>
            <X size={16} /> Cancel
          </button>
        </div>
      </form>
      <Tooltip id="rule-tip" />
    </Modal>
  )
}
