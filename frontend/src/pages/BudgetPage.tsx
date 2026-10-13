import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Check, Rows, Rows2, Rows3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { isIncomeKind } from '../categoryConfig'
import { Loading, Modal } from '../components/ui'
import { Tooltip } from 'react-tooltip'
import { centsToInput, formatMoney, todayIso } from '../money'
import { useCategoryConfig } from '../queries'
import { useRun } from '../toast'
import type { BudgetLine } from '../types'

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-CA', { month: 'long', year: 'numeric' })
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Tolerate pasted currency/grouping: "$1,200", "1 200.50", "1.200,50" is not handled on purpose. */
function normalizeAmount(text: string): string {
  return text.replace(/[$€£\s,]/g, '')
}

/** Plain "1234.56" -> integer cents; null when it isn't a usable amount. */
function parsePlain(text: string): number | null {
  const t = normalizeAmount(text)
  if (t === '') return 0
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null
  const neg = t.startsWith('-')
  const [int, frac = ''] = t.replace('-', '').split('.')
  const cents = Number(int) * 100 + Number((frac + '00').slice(0, 2))
  return (neg ? -1 : 1) * cents
}

/** On-screen editable budget for a leaf category. Plays nicely with the parent totals that live in `template`. */
function BudgetInput({
  cents,
  custom,
  onCommit,
  label,
}: {
  cents: number
  custom: boolean
  onCommit: (v: number) => void
  label: string
}) {
  const [text, setText] = useState(centsToInput(cents))
  const [focused, setFocused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastCents = useRef(cents)

  useEffect(() => {
    if (lastCents.current === cents) return
    lastCents.current = cents
    setError(null)
    if (!focused) setText(centsToInput(cents))
  }, [cents, focused])

  function commit() {
    const parsed = parsePlain(text)
    if (parsed == null) {
      setError('Enter a number like 250 or 250.75')
      return
    }
    if (parsed < 0) {
      setError('A budget cannot be negative')
      return
    }
    setError(null)
    onCommit(parsed)
    setText(centsToInput(parsed))
  }

  return (
    <span className="budget-field">
      <input
        className={`budget-input${error ? ' invalid' : custom ? ' custom' : ''}`}
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        onChange={(e) => {
          setText(e.target.value)
          if (error) setError(null)
        }}
      />
      {error && (
        <span className="err-text small" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

export default function BudgetPage() {
  const run = useRun()
  const config = useCategoryConfig().data
  const [params, setParams] = useSearchParams()
  const month = params.get('month') || todayIso().slice(0, 7)
  const setMonth = (m: string) => m && setParams({ month: m })

  const query = useQuery({
    queryKey: ['budget', month],
    queryFn: () => api.budget(month),
    placeholderData: keepPreviousData,
  })
  const data = query.data

  // ---- on-screen template: leaf category_id -> planned cents -------------------------
  const [template, setTemplate] = useState<Record<number, number>>({})
  const [selected, setSelected] = useState<Record<number, boolean>>({})
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [density, setDensity] = useState<'compact' | 'medium' | 'loose'>('medium')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<{ month: string; values: Record<number, number>; changed: number } | null>(null)
  const allRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!data || seededFor === data.month) return
    const m: Record<number, number> = {}
    const sel: Record<number, boolean> = {}
    for (const line of data.lines) {
      if (line.has_children) continue
      m[line.category_id] = line.budget_cents
      sel[line.category_id] = true
    }
    setTemplate(m)
    setSelected(sel)
    setSeededFor(data.month)
  }, [data, seededFor])

  const lines = data?.lines ?? []
  const defaults = Object.fromEntries(lines.filter((l) => !l.has_children).map((l) => [l.category_id, l.default_cents]))
  const childrenOf = new Map<number, BudgetLine[]>()
  for (const l of lines) {
    if (l.parent_id != null) childrenOf.set(l.parent_id, [...(childrenOf.get(l.parent_id) ?? []), l])
  }

  function leafIds(line: BudgetLine): number[] {
    if (!line.has_children) return [line.category_id]
    return (childrenOf.get(line.category_id) ?? []).flatMap(leafIds)
  }

  const leafValue = (id: number): number => ((selected[id] ?? true) ? (template[id] ?? 0) : 0)

  function treeBudget(line: BudgetLine): number {
    if (!line.has_children) return leafValue(line.category_id)
    return (childrenOf.get(line.category_id) ?? []).reduce((sum, k) => sum + treeBudget(k), 0)
  }

  function reset(line: BudgetLine) {
    const next = { ...template }
    const nextSel = { ...selected }
    for (const id of leafIds(line)) {
      next[id] = defaults[id] ?? 0
      nextSel[id] = true
    }
    setTemplate(next)
    setSelected(nextSel)
  }

  const setLeaf = (id: number, v: number) => setTemplate((t) => ({ ...t, [id]: v }))
  const toggleSelected = (id: number, on: boolean) => setSelected((s) => ({ ...s, [id]: on }))

  const leafLines = lines.filter((l) => !l.has_children)
  const allSelected = leafLines.length > 0 && leafLines.every((l) => selected[l.category_id] ?? true)
  const someSelected = leafLines.some((l) => selected[l.category_id] ?? true)

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected && !allSelected
  }, [someSelected, allSelected])

  function toggleAll() {
    const next: Record<number, boolean> = {}
    for (const l of leafLines) next[l.category_id] = !allSelected
    setSelected(next)
  }

  function appliedValues(): Record<number, number> {
    const v: Record<number, number> = {}
    for (const l of leafLines) v[l.category_id] = leafValue(l.category_id)
    return v
  }

  const incomeBudgeted = lines.filter((l) => !l.has_children && isIncomeKind(config, l.kind)).reduce((s, l) => s + leafValue(l.category_id), 0)
  const expenseBudgeted = lines.filter((l) => !l.has_children && !isIncomeKind(config, l.kind)).reduce((s, l) => s + leafValue(l.category_id), 0)
  const unassigned = incomeBudgeted - expenseBudgeted
  const unassignedWord = unassigned === 0 ? 'balanced' : unassigned < 0 ? 'over' : 'left'
  const changeCount = leafLines.filter((l) => leafValue(l.category_id) !== l.budget_cents).length
  const dirty = changeCount > 0

  function isCustom(line: BudgetLine): boolean {
    if (!line.has_children) return !(selected[line.category_id] ?? true) || (template[line.category_id] ?? 0) !== (defaults[line.category_id] ?? 0)
    return leafIds(line).some((id) => !(selected[id] ?? true) || (template[id] ?? 0) !== (defaults[id] ?? 0))
  }

  function discard() {
    const m: Record<number, number> = {}
    const sel: Record<number, boolean> = {}
    for (const l of leafLines) {
      m[l.category_id] = l.budget_cents
      sel[l.category_id] = true
    }
    setTemplate(m)
    setSelected(sel)
  }

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  async function generate() {
    if (!data) return
    const values = appliedValues()
    setBusy(true)
    const res = await run(
      () => api.generateBudget(month, values),
      (r) => (r.changed === 0 ? `${monthLabel(month)} already matched this template` : `Applied ${plural(r.changed, 'budget')} to ${monthLabel(month)}`),
    )
    setBusy(false)
    setConfirming(false)
    if (res) setUndo({ month, values, changed: res.changed })
  }

  async function undoGenerate() {
    if (!undo) return
    setBusy(true)
    const ok = await run(() => api.generateBudget(undo.month, undo.values), 'Reverted to the previous budgets')
    setBusy(false)
    if (ok) setUndo(null)
  }

  return (
    <>
      <h1>Budget</h1>
      <p className="muted mb-12">
        Tick the categories that belong in this month's budget, set their amounts, then apply the template. Unchecked categories get no
        budget for the month. Nothing is saved until you apply.
      </p>

      <Loading query={query} />
      {data && (
        <>
          <div className="month-nav mb-12">
            <div className="inline-field-right">
              <div className="month-field">
                <label htmlFor="bud-month">Month</label>
                <input id="bud-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              </div>
              <span className="budget-primary">
                <button type="button" onClick={() => setConfirming(true)} disabled={!data || busy}>
                  Apply template
                </button>
              </span>
            </div>
            <div className="push">
              <div className="density-toggle" role="group" aria-label="Row density">
                <button
                  type="button"
                  className={density === 'compact' ? 'on' : ''}
                  aria-pressed={density === 'compact'}
                  aria-label="Compact rows"
                  data-tooltip-id="budget-tip"
                  data-tooltip-content="Compact rows"
                  onClick={() => setDensity('compact')}
                >
                  <Rows size={16} />
                </button>
                <button
                  type="button"
                  className={density === 'medium' ? 'on' : ''}
                  aria-pressed={density === 'medium'}
                  aria-label="Medium rows"
                  data-tooltip-id="budget-tip"
                  data-tooltip-content="Medium rows"
                  onClick={() => setDensity('medium')}
                >
                  <Rows2 size={16} />
                </button>
                <button
                  type="button"
                  className={density === 'loose' ? 'on' : ''}
                  aria-pressed={density === 'loose'}
                  aria-label="Spacious rows"
                  data-tooltip-id="budget-tip"
                  data-tooltip-content="Spacious rows"
                  onClick={() => setDensity('loose')}
                >
                  <Rows3 size={16} />
                </button>
              </div>
            </div>
          </div>

          {dirty && (
            <div className="flash info undo-bar" role="status">
              <span>
                {plural(changeCount, 'unsaved change')} — apply to {monthLabel(month)} to save.
              </span>
              <span className="row-actions">
                <button type="button" className="secondary small" onClick={discard} disabled={busy}>
                  Discard
                </button>
                <button type="button" className="small" onClick={() => setConfirming(true)} disabled={busy}>
                  Apply
                </button>
              </span>
            </div>
          )}

          {undo && undo.month === month && (
            <div className="flash ok undo-bar" role="status">
              <span>
                {undo.changed === 0 ? `${monthLabel(month)} already matched the template.` : `Applied ${plural(undo.changed, 'budget')} to ${monthLabel(month)}.`}
              </span>
              <button type="button" className="secondary small" onClick={undoGenerate} disabled={busy}>
                Undo
              </button>
            </div>
          )}

          {lines.length === 0 ? (
            <div className="card">
              <p>No categories to budget yet.</p>
              <p className="muted small">
                Add categories in <Link to="/settings/categories">Settings → Categories</Link>, then plan them here.
              </p>
            </div>
          ) : (
            <div className={`panel table-wrap${query.isPlaceholderData ? ' refreshing' : ''}`} aria-busy={query.isPlaceholderData}>
              {query.isPlaceholderData && (
                <span className="sr-only" role="status">
                  Loading {monthLabel(month)}…
                </span>
              )}
              <table className={density !== 'medium' ? `budget-table den-${density}` : 'budget-table'}>
                <colgroup>
                  <col />
                  <col style={{ width: 84 }} />
                  <col style={{ width: 128 }} />
                  <col style={{ width: 40 }} />
                  <col style={{ width: 44 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <input
                        ref={allRef}
                        type="checkbox"
                        className="inc-check"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label={`Include all categories in ${monthLabel(month)}`}
                      />
                      Category
                    </th>
                    <th className="num">
                      <span data-tooltip-id="budget-tip" data-tooltip-content="The category's usual monthly budget">
                        Default
                      </span>
                    </th>
                    <th className="num">
                      <span data-tooltip-id="budget-tip" data-tooltip-content={`${monthLabel(month)}'s budget — edit a row to change it`}>
                        This month
                      </span>
                    </th>
                    <th className="num">
                      <span data-tooltip-id="budget-tip" data-tooltip-content="An active recurring rule covers this category">
                        Recurring
                      </span>
                    </th>
                    <th>
                      <span className="sr-only">Reset</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const budget = treeBudget(line)
                    const excluded = !line.has_children && !(selected[line.category_id] ?? true)
                    return (
                      <tr key={line.category_id} className={`${line.depth === 0 ? 'root ' : ''}${excluded ? 'excluded' : ''}`}>
                        <td style={{ paddingLeft: `calc(10px + ${line.depth} * var(--tree-indent, 18px))` }}>
                          {line.has_children ? (
                            <span className="inc-spacer" aria-hidden="true" />
                          ) : (
                            <input
                              type="checkbox"
                              className="inc-check"
                              checked={selected[line.category_id] ?? true}
                              onChange={(e) => toggleSelected(line.category_id, e.target.checked)}
                              aria-label={`Include ${line.name} in ${monthLabel(month)}`}
                            />
                          )}
                          {line.depth > 0 && <span className="sr-only">{`Level ${line.depth}: `}</span>}
                          {line.name}
                          {!line.is_active && <span className="chip">inactive</span>}
                        </td>
                        <td className="num muted" data-label="Default">{formatMoney(line.default_cents, true)}</td>
                        <td className="num" data-label="This month">
                          {line.has_children ? (
                            formatMoney(budget, true)
                          ) : (
                            <BudgetInput
                              cents={template[line.category_id] ?? 0}
                              custom={isCustom(line)}
                              onCommit={(v) => setLeaf(line.category_id, v)}
                              label={`${line.name} budget`}
                            />
                          )}
                        </td>
                        <td className="num" data-label="Recurring">{line.recurring_cents ? <Check size={16} aria-label="Recurring" /> : ''}</td>
                        <td className="num" data-label="Reset">
                          {isCustom(line) && (
                            <button
                              type="button"
                              className="icon-btn ghost"
                              aria-label={`Reset ${line.name} to the category default`}
                              data-tooltip-id="budget-tip"
                              data-tooltip-content="Reset to the category default"
                              onClick={() => reset(line)}
                            >
                              <img src="/static/reset.svg?v=1" alt="" className="icon-img" />
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <td>Total income</td>
                    <td className="num muted" data-label="Default">{formatMoney(lines.filter((l) => l.depth === 0 && isIncomeKind(config, l.kind)).reduce((s, l) => s + l.default_cents, 0))}</td>
                    <td className="num" data-label="This month">{formatMoney(incomeBudgeted)}</td>
                    <td></td>
                    <td></td>
                  </tr>
                  <tr className="total-row">
                    <td>Total expenses</td>
                    <td className="num muted" data-label="Default">{formatMoney(lines.filter((l) => l.depth === 0 && !isIncomeKind(config, l.kind)).reduce((s, l) => s + l.default_cents, 0))}</td>
                    <td className="num" data-label="This month">{formatMoney(expenseBudgeted)}</td>
                    <td></td>
                    <td></td>
                  </tr>
                  <tr className="total-row">
                    <td>
                      <span data-tooltip-id="budget-tip" data-tooltip-content="Income budget minus everything you've budgeted — zero means every dollar is assigned">
                        Left to assign
                      </span>
                    </td>
                    <td className="num"></td>
                    <td className={`num ${unassigned === 0 ? 'zero-ok' : unassigned < 0 ? 'zero-bad' : ''}`} aria-live="polite">
                      {formatMoney(unassigned)} <span className="small muted">{unassignedWord}</span>
                    </td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <Tooltip id="budget-tip" />

          {confirming && (
            <Modal title={`Apply this template to ${monthLabel(month)}?`} onClose={() => setConfirming(false)}>
              <p>
                This sets {monthLabel(month)}'s budgets from the categories you've ticked; unchecked categories get no budget for the
                month. Any budgets already saved for {monthLabel(month)} are overwritten.
              </p>
              <p className="muted small">
                {changeCount === 0
                  ? 'Nothing on screen differs from what is already saved.'
                  : `${plural(changeCount, 'category')} will change. You can undo this right after.`}
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" className="shrink" onClick={generate} disabled={busy}>
                  {busy ? 'Applying…' : 'Apply template'}
                </button>
                <button type="button" className="secondary shrink" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </Modal>
          )}
        </>
      )}
    </>
  )
}
