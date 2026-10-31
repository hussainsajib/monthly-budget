import { Plus, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { centsToInput } from '../money'
import { useAccounts, useImportCategories, useImportRules } from '../queries'
import { useRun, useToast } from '../toast'
import type { ImportRule, ImportRuleBody } from '../types'
import { AddCategoryModal } from './AddCategoryModal'
import { AccountSelect, CategorySelect, OptionSelect } from './selects'
import { Modal } from './ui'
import { Tooltip } from 'react-tooltip'

export interface RuleDraft {
  match_text: string
  amount: string
  account_id: number | null
  day_from: number | null
  day_to: number | null
  category_id: number | null
  loan_account_id: number | null
  is_active: boolean
}

export type ReadyRuleDraft = RuleDraft & { account_id: number }

export const EMPTY_RULE: RuleDraft = {
  match_text: '',
  amount: '',
  account_id: null,
  day_from: null,
  day_to: null,
  category_id: null,
  loan_account_id: null,
  is_active: true,
}

export const ruleToDraft = (r: ImportRule): ReadyRuleDraft => ({
  match_text: r.match_text,
  amount: centsToInput(r.amount_cents),
  account_id: r.account_id,
  day_from: r.day_from,
  day_to: r.day_to,
  category_id: r.loan_account_id != null ? null : r.category_id,
  loan_account_id: r.loan_account_id,
  is_active: r.is_active,
})

/** Why a draft cannot be saved yet, or null when it is ready. */
export function draftProblem(d: RuleDraft): string | null {
  if (!hasIdentifier(d)) return 'Add a description, an amount, or a date to identify the transaction'
  if (d.account_id == null) return 'Pick an account'
  if (d.loan_account_id == null && d.category_id == null) return 'Pick a category or a loan to pay'
  return null
}

/** A rule needs at least one of description, amount or day to identify a transaction. */
export const hasIdentifier = (d: RuleDraft) =>
  d.match_text.trim() !== '' || d.amount.trim() !== '' || d.day_from !== null || d.day_to !== null

export function draftToBody(d: ReadyRuleDraft, sortOrder = 0): ImportRuleBody {
  return {
    match_text: d.match_text,
    amount: d.amount || null,
    account_id: d.account_id,
    day_from: d.day_from,
    day_to: d.day_to,
    category_id: d.loan_account_id != null ? null : d.category_id,
    loan_account_id: d.loan_account_id,
    sort_order: sortOrder,
    is_active: d.is_active,
  }
}

export function DraftFields({ draft, onChange, idPrefix }: { draft: RuleDraft; onChange: (d: RuleDraft) => void; idPrefix: string }) {
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...draft, [k]: v })
  const accounts = useAccounts().data ?? []
  const categories = useImportCategories().data ?? []
  const loanOptions = [
    { value: '', label: 'None, assign a category' },
    ...accounts
      .filter((a) => a.is_loan && a.is_active && a.id !== draft.account_id)
      .map((a) => ({ value: String(a.id), label: a.name })),
  ]
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
      <div className="field-full">
        <label htmlFor={`${idPrefix}-loan`}>Pay a loan</label>
        <OptionSelect
          id={`${idPrefix}-loan`}
          label="Loan to pay"
          searchable
          value={draft.loan_account_id == null ? '' : String(draft.loan_account_id)}
          onChange={(v) => set('loan_account_id', v === '' ? null : Number(v))}
          options={loanOptions}
        />
      </div>
      {draft.loan_account_id == null && (
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
      )}
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

  function valid(d: RuleDraft): d is ReadyRuleDraft {
    const problem = draftProblem(d)
    return problem ? (fail(problem) ?? false) : true
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

const ruleLabel = (r: ImportRule) => {
  const what = [r.match_text, r.amount_cents != null ? `$${centsToInput(r.amount_cents)}` : ''].filter(Boolean).join(' · ')
  return `${what || 'Any transaction'} → ${r.loan_account_name ? `pay ${r.loan_account_name}` : r.category_path}${r.account_name ? ` (${r.account_name})` : ''}`
}

const mergeMatchText = (ruleText: string, rowText: string) => {
  const row = rowText.trim()
  if (!row) return ruleText
  if (!ruleText.trim()) return row.slice(0, 256)
  const has = ruleText.split('|').some((p) => p.trim().toLowerCase() === row.toLowerCase())
  return has ? ruleText : `${ruleText} | ${row}`.slice(0, 256)
}

/** Pick an existing import rule and edit it, folding the import row's description into its match text. */
export function UpdateImportRuleModal({
  row,
  onClose,
  onUpdated,
}: {
  row: RuleDraft
  onClose: () => void
  onUpdated?: () => void
}) {
  const run = useRun()
  const { fail } = useToast()
  const rules = useImportRules().data ?? []
  const [ruleId, setRuleId] = useState('')
  const [draft, setDraft] = useState<RuleDraft>(row)
  const rule = rules.find((r) => String(r.id) === ruleId)

  function choose(id: string) {
    setRuleId(id)
    const picked = rules.find((r) => String(r.id) === id)
    if (!picked) return
    const base = ruleToDraft(picked)
    setDraft({ ...base, match_text: mergeMatchText(base.match_text, row.match_text) })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!rule) return fail('Pick the rule to update')
    const problem = draftProblem(draft)
    if (problem || draft.account_id == null) return fail(problem ?? 'Pick an account')
    const body = draftToBody({ ...draft, account_id: draft.account_id }, rule.sort_order)
    if (await run(() => api.updateImportRule(rule.id, body), 'Updated rule')) {
      onUpdated?.()
      onClose()
    }
  }

  return (
    <Modal title="Update import rule" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field-full">
            <label htmlFor="rule-update-pick">Rule</label>
            <OptionSelect
              id="rule-update-pick"
              label="Rule to update"
              searchable
              value={ruleId}
              onChange={choose}
              options={rules.map((r) => ({ value: String(r.id), label: ruleLabel(r) }))}
            />
          </div>
          {rule && <DraftFields key={rule.id} draft={draft} onChange={setDraft} idPrefix="rule-update" />}
        </div>
        {rule ? (
          <p className="small muted">
            This row's description was added to the rule's match text. Edit anything before saving.
          </p>
        ) : (
          <p className="small muted">Choose a rule to edit.</p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="shrink" type="submit" disabled={!rule}>
            Save rule
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
