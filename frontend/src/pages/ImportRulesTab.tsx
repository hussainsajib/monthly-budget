import { ChevronDown, ChevronUp, Pencil, Power, Trash, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import {
  AddImportRuleModal,
  DraftFields,
  EMPTY_RULE,
  draftToBody,
  hasIdentifier,
  ruleToDraft,
  type RuleDraft,
} from '../components/ImportRuleDialog'
import { Bar } from '../components/table'
import { Modal } from '../components/ui'
import { formatMoney } from '../money'
import { useImportRules } from '../queries'
import { useRun, useToast } from '../toast'
import type { ImportRule } from '../types'

const range = (r: ImportRule) => {
  if (r.day_from != null && r.day_to != null) return `day ${r.day_from}–${r.day_to}`
  if (r.day_from != null) return `from day ${r.day_from}`
  if (r.day_to != null) return `until day ${r.day_to}`
  return '—'
}

function RulesSkeleton() {
  return (
    <table>
      <thead>
        <tr>
          <th>Rule</th>
          <th>Account</th>
          <th>Date</th>
          <th>Category</th>
          <th className="hide-sm">Precedence</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 4 }).map((_, row) => (
          <tr key={row}>
            <td>
              <Bar w={180} />
            </td>
            <td>
              <Bar w={110} />
            </td>
            <td>
              <Bar w={120} />
            </td>
            <td>
              <Bar w={150} />
            </td>
            <td className="hide-sm">
              <Bar w={48} />
            </td>
            <td />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function ImportRulesTab() {
  const run = useRun()
  const { fail } = useToast()
  const query = useImportRules()
  const rules = query.data ?? []
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE)
  const [modal, setModal] = useState<{ mode: 'add' } | { mode: 'edit'; id: number } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const editing = modal?.mode === 'edit' ? rules.find((r) => r.id === modal.id) : undefined

  function closeModal() {
    setModal(null)
    setConfirming(false)
  }

  function openAdd() {
    setConfirming(false)
    setModal({ mode: 'add' })
  }

  function openEdit(r: ImportRule) {
    setDraft(ruleToDraft(r))
    setConfirming(false)
    setModal({ mode: 'edit', id: r.id })
  }

  function valid(d: RuleDraft): d is RuleDraft & { account_id: number; category_id: number } {
    if (!hasIdentifier(d)) return fail('Add a description, an amount, or a date to identify the transaction') ?? false
    if (d.account_id == null) return fail('Pick an account') ?? false
    if (d.category_id == null) return fail('Pick a category') ?? false
    return true
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing || !valid(draft)) return
    if (await run(() => api.updateImportRule(editing.id, draftToBody(draft, editing.sort_order)), 'Saved')) closeModal()
  }

  async function destroy() {
    if (!editing) return
    if (await run(() => api.deleteImportRule(editing.id).then(() => true), 'Deleted rule')) closeModal()
  }

  const toggleActive = (r: ImportRule) =>
    void run(
      () => api.updateImportRule(r.id, { ...draftToBody(ruleToDraft(r), r.sort_order), is_active: !r.is_active }),
      r.is_active ? 'Disabled rule' : 'Enabled rule',
    )

  const move = (r: ImportRule, dir: 'up' | 'down') => void run(() => api.moveImportRule(r.id, dir))

  return (
    <>
      <div className="set-head">
        <h2>Import rules</h2>
        <span className="set-counts">
          <span className="chip">{rules.length} rule{rules.length === 1 ? '' : 's'}</span>
        </span>
        <button
          className="push icon-btn ghost"
          type="button"
          aria-label="Add rule"
          data-tooltip-id="settings-tip"
          data-tooltip-content="Add rule"
          onClick={openAdd}
        >
          <img src="/static/add.svg?v=2" alt="" className="icon-img icon-img-lg" />
        </button>
      </div>

      <p className="small muted" style={{ margin: '0 0 12px' }}>
        When importing a CSV, a transaction matching a rule's description, amount, account and date range is automatically
        categorized in the preview. Rules fill in only when history hasn't suggested a category; the first matching rule above
        wins.
      </p>

      {modal?.mode === 'add' && <AddImportRuleModal onClose={closeModal} />}

      {modal?.mode === 'edit' && editing && (
        <Modal title="Edit import rule" onClose={closeModal}>
          <form onSubmit={save}>
            <div className="form-grid">
              <DraftFields draft={draft} onChange={setDraft} idPrefix="rule-edit" />
            </div>
            <label className="check">
              <input type="checkbox" checked={draft.is_active} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })} />{' '}
              Active — disabled rules stay saved but don't match
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="shrink with-icon" type="submit">
                <img src="/static/save.svg?v=2" alt="" className="icon-img" /> Save
              </button>
              <button className="secondary shrink with-icon" type="button" onClick={closeModal}>
                <X size={16} /> Cancel
              </button>
            </div>

            <div className="danger-zone">
              <h2>Delete</h2>
              {confirming ? (
                <div className="confirm-box">
                  <p>Delete this rule? It won't affect any already-imported transactions.</p>
                  <div className="row">
                    <button className="danger shrink with-icon" type="button" onClick={destroy}>
                      <Trash size={16} /> Delete
                    </button>
                    <button className="secondary shrink" type="button" onClick={() => setConfirming(false)}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="danger shrink with-icon" type="button" onClick={() => setConfirming(true)}>
                    <Trash size={16} /> Delete rule
                  </button>
                </div>
              )}
            </div>
          </form>
        </Modal>
      )}

      {query.isError && <div className="flash err">{query.error?.message ?? 'Failed to load'}</div>}

      {query.isPending ? (
        <div className="card table-wrap">
          <RulesSkeleton />
        </div>
      ) : rules.length === 0 ? (
        <div className="card">
          <p className="muted">
            No import rules yet. Add one to auto-assign a category in the preview whenever a transaction matches a description, an
            amount or a date range.
          </p>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Account</th>
                <th>Date</th>
                <th>Category</th>
                <th className="hide-sm">Precedence</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r, i) => (
                <tr key={r.id}>
                  <td>
                    <span className="row-label">
                      <span className="nm">
                        {r.match_text ? r.match_text : <span className="empty-cell">any description</span>}
                      </span>
                      {r.amount_cents != null && <span className="chip">{formatMoney(r.amount_cents)}</span>}
                      {!r.is_active && <span className="chip">disabled</span>}
                    </span>
                  </td>
                  <td>{r.account_name ?? <span className="empty-cell">—</span>}</td>
                  <td>{range(r)}</td>
                  <td>{r.category_path || <span className="empty-cell">—</span>}</td>
                  <td className="hide-sm icon-group">
                    <button
                      type="button"
                      className="icon-btn ghost"
                      aria-label={`Move ${r.match_text || 'rule'} up`}
                      disabled={i === 0}
                      data-tooltip-id="settings-tip"
                      data-tooltip-content="Higher priority (matches first)"
                      onClick={() => move(r, 'up')}
                    >
                      <ChevronUp size={18} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn ghost"
                      aria-label={`Move ${r.match_text || 'rule'} down`}
                      disabled={i === rules.length - 1}
                      data-tooltip-id="settings-tip"
                      data-tooltip-content="Lower priority"
                      onClick={() => move(r, 'down')}
                    >
                      <ChevronDown size={18} />
                    </button>
                  </td>
                  <td className="icon-group">
                    <button
                      type="button"
                      className="icon-btn ghost"
                      aria-label={r.is_active ? `Disable ${r.match_text || 'rule'}` : `Enable ${r.match_text || 'rule'}`}
                      data-tooltip-id="settings-tip"
                      data-tooltip-content={r.is_active ? 'Disable' : 'Enable'}
                      onClick={() => toggleActive(r)}
                    >
                      <Power size={18} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn ghost"
                      aria-label={`Edit ${r.match_text || 'rule'}`}
                      data-tooltip-id="settings-tip"
                      data-tooltip-content="Edit"
                      onClick={() => openEdit(r)}
                    >
                      <Pencil size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
